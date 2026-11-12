import {SignalProtocolAddress, SessionBuilder, SessionCipher} from "@privacyresearch/libsignal-protocol-typescript";
import type {SignalStore} from "./signalStore.ts";
import {fetchUserKeys} from "./keyDirectory.ts";
import {unb64, b64} from "./deviceKey.ts";
import {clearVerified} from "./safetyNumber.ts";
import {logger} from "@/shared/logger/logger.ts";

// Phase 2c + 2d core: turn a peer userId + plaintext into an opaque E2EE envelope (encrypt to EACH of the
// peer's devices), and turn an incoming envelope back into plaintext. Sessions are established via X3DH
// from the directory's prekey bundles on first contact, then advanced by the Double Ratchet per message.
// The envelope rides in the messenger's existing opaque payload.body — the server never sees plaintext.

export const ENVELOPE_V = 1;

// Thrown when the peer has published no keys yet (never opened the app since E2EE shipped). Distinct from a
// crypto failure so the UI can tell the user to ask their contact to open the app, rather than a vague error.
export const NO_PEER_KEYS = "NO_PEER_KEYS";

// One recipient device's ciphertext. `t` = libsignal message type (3 = prekey/X3DH-init, 1 = ratchet).
interface DeviceCipher { t: number; b: string }   // b = base64 ciphertext body
export interface SecretEnvelope {
    v: number;
    alg: "signal";
    from: string;                                   // sender's deviceId (uuid)
    to: Record<string, DeviceCipher>;               // recipientDeviceId(uuid) → ciphertext
}

// libsignal's SignalProtocolAddress needs a NUMERIC deviceId; our directory identifies devices by UUID
// string. Map the UUID to a stable positive int (used only to key the local session — not cryptographic).
function addrDeviceNum(deviceUuid: string): number {
    let h = 0;
    for (let i = 0; i < deviceUuid.length; i++) h = (Math.imul(31, h) + deviceUuid.charCodeAt(i)) | 0;
    return (h & 0x7fffffff) || 1;
}
const addrOf = (userId: string, deviceUuid: string) => new SignalProtocolAddress(userId, addrDeviceNum(deviceUuid));

// How long a cached peer roster snapshot is trusted before the next send re-resolves it (ms).
const ROSTER_TTL_MS = 24 * 60 * 60 * 1000;   // 24h

/** Invalidate the cached roster for a peer so the next send re-resolves from the directory. Established
 * sessions are kept — only the "which devices" snapshot is dropped. Called when a peer's device sends us a
 * rekey hint (it received a message we addressed to a stale device of theirs). Note: a peer re-provision in
 * this client always yields a NEW deviceId, so the mis-addressed message triggers that hint — there is no
 * separate "same-device identity rotation" path to invalidate on (the client never rotates identity in
 * place); if that ever changes, add a local-decrypt-failure invalidation here. */
export async function invalidatePeer(store: SignalStore, peerUserId: string): Promise<void> {
    await store.deleteRosterSnapshot(peerUserId);
}

/**
 * Ensure we have a Double Ratchet session to every one of `peerUserId`'s devices, establishing any missing
 * one via X3DH from its directory bundle. Fetching a bundle CONSUMES a one-time prekey server-side, so we
 * take a FAST PATH: if a fresh roster snapshot exists AND we already hold a live session to each of its
 * devices, we return those device ids WITHOUT touching the directory (no OPK spend). Only a cache miss /
 * stale snapshot / missing session falls through to a fetch + X3DH. Returns the peer device UUIDs.
 */
async function ensureSessions(store: SignalStore, peerUserId: string): Promise<string[]> {
    // Fast path: reuse cached sessions when the roster snapshot is fresh and every device still has a session.
    const snap = await store.getRosterSnapshot(peerUserId);
    if (snap && snap.deviceIds.length && (Date.now() - snap.fetchedAt) < ROSTER_TTL_MS) {
        let allLive = true;
        for (const dev of snap.deviceIds) {
            if (!(await store.loadSession(addrOf(peerUserId, dev).toString()))) { allLive = false; break; }
        }
        if (allLive) return snap.deviceIds;
    }

    const known: string[] = [];
    const need: string[] = [];
    // Cache miss / stale → fetch the roster (consumes an OPK per device) and establish any missing sessions.
    const {devices} = await fetchUserKeys(peerUserId);
    if (devices.length === 0) throw new Error(NO_PEER_KEYS);   // peer never provisioned → can't X3DH
    for (const dev of devices) {
        const addr = addrOf(peerUserId, dev.deviceId);
        const fresh = unb64(dev.identityKey);
        if (await store.loadSession(addr.toString())) {
            // A session exists — but the peer may have RE-PROVISIONED (new identity key).
            // The old session then carries a stale identity and its safety number can
            // never match the peer's. Compare the directory's CURRENT identity with the
            // one this session was built on; if unchanged, keep the session.
            const stored = await store.loadIdentityKey(addr.toString());
            if (stored && b64(stored) === b64(fresh)) { known.push(dev.deviceId); continue; }
            // Identity changed → tear the stale session down and re-key from the fresh
            // bundle below. Drop verification so the user re-verifies the new number.
            await store.deleteSession(addr.toString());
            clearVerified(peerUserId);
            logger.warn("e2ee: peer identity changed — re-establishing session", {peerUserId, dev: dev.deviceId});
        }
        // No session (or the stale one was just torn down) → run X3DH from this bundle.
        const builder = new SessionBuilder(store, addr);
        await builder.processPreKey({
            registrationId: addrDeviceNum(dev.deviceId),          // directory carries no regId → synthesize (non-crypto)
            identityKey: unb64(dev.identityKey),
            signedPreKey: { keyId: dev.signedPreKey.id, publicKey: unb64(dev.signedPreKey.publicKey), signature: unb64(dev.signedPreKey.signature) },
            preKey: dev.oneTimePreKey ? { keyId: dev.oneTimePreKey.id, publicKey: unb64(dev.oneTimePreKey.publicKey) } : undefined,
        });
        known.push(dev.deviceId);
        need.push(dev.deviceId);
    }
    if (need.length) logger.debug("e2ee: established sessions", {peerUserId, newDevices: need.length});
    // Drop stored identities for any of the peer's OLD devices no longer in the roster (e.g. after a
    // re-provision). Otherwise a stale peer identity lingers and the safety number never reconverges.
    await store.retainPeerDevices(peerUserId, new Set(known.map((u) => addrOf(peerUserId, u).toString())));
    // Cache the freshly-resolved roster so subsequent sends reuse the sessions without a fetch/OPK spend.
    await store.putRosterSnapshot(peerUserId, known);
    return known;
}

/**
 * Reconcile our stored peer state with the directory's CURRENT roster: re-pin each live device's identity
 * and PRUNE every stored identity for a device no longer published. A peer that re-provisions leaves dead
 * device identities behind; `getPeerIdentity` (find-first) could then return a stale one and the safety
 * number never matches. Unlike `ensureSessions`, this establishes no session — it only refreshes identities
 * — so the safety-number view can converge without sending a message. (Fetching the roster consumes an OPK
 * per device server-side, so this is called on explicit user action, e.g. opening the safety-number view.)
 * Returns the number of live devices the directory reports (1 in the normal 1:1 case; >1 signals the
 * directory is still serving dead devices, which no client-side prune can disambiguate).
 */
export async function reconcilePeerIdentities(store: SignalStore, peerUserId: string): Promise<number> {
    const {devices} = await fetchUserKeys(peerUserId);
    if (devices.length === 0) return 0;                         // peer unprovisioned → nothing to reconcile
    const keep = new Set<string>();
    for (const dev of devices) {
        const addr = addrOf(peerUserId, dev.deviceId).toString();
        keep.add(addr);
        await store.saveIdentity(addr, unb64(dev.identityKey));  // re-pin the CURRENT identity for this device
    }
    await store.retainPeerDevices(peerUserId, keep);            // drop identities of devices no longer published
    return devices.length;
}

/** Encrypt `plaintext` to every device of `peerUserId`. `myDeviceId` = our own device uuid (for the envelope). */
export async function encryptTo(store: SignalStore, peerUserId: string, myDeviceId: string, plaintext: string): Promise<SecretEnvelope> {
    const deviceIds = await ensureSessions(store, peerUserId);
    const to: Record<string, DeviceCipher> = {};
    const bytes = new TextEncoder().encode(plaintext).buffer;
    for (const dev of deviceIds) {
        const cipher = new SessionCipher(store, addrOf(peerUserId, dev));
        const msg = await cipher.encrypt(bytes);                  // {type, body}
        to[dev] = { t: msg.type, b: b64(binaryStringToBuffer(msg.body ?? "")) };
    }
    return { v: ENVELOPE_V, alg: "signal", from: myDeviceId, to };
}

/**
 * Decrypt an incoming envelope from `senderUserId`. Picks the ciphertext addressed to OUR device
 * (`myDeviceId`), dispatches on message type (prekey vs ratchet), and returns the plaintext. Throws if the
 * envelope carries nothing for us (e.g. we're a device the sender didn't have keys for) or on a dup/replay.
 */
export async function decryptFrom(store: SignalStore, senderUserId: string, myDeviceId: string, env: SecretEnvelope): Promise<string> {
    const mine = env.to[myDeviceId];
    if (!mine) throw new Error("e2ee: envelope has no ciphertext for this device");
    const addr = addrOf(senderUserId, env.from);
    const cipher = new SessionCipher(store, addr);
    const body = bufferToBinaryString(unb64(mine.b));
    const plain = mine.t === 3
        ? await cipher.decryptPreKeyWhisperMessage(body, "binary")
        : await cipher.decryptWhisperMessage(body, "binary");
    return new TextDecoder().decode(plain);
}

// --- Recovery over an ORTHOGONAL session (Step B fix) ------------------------------------------------
// A stalled ratchet can't be repaired by another message ON that ratchet — the repair lands past the same
// gap. So recovery rides a DEDICATED, always-FRESH session at a distinct address, independent of the
// normal (possibly-stalled) chain. Each recovery batch tears down + re-establishes the recovery session
// via X3DH, so its first message is a prekey message and the receiver builds a clean receive chain — no
// gap to cross. The recovered plaintext is AEAD-BOUND to its identity: {mid, cid} travel INSIDE the
// encryption, so a tampered response can't relabel one message as another.

export const RECOVERY_DEVICE_ID = 0x5EC0;    // a distinct address lane, never colliding with the normal session
const recAddr = (userId: string) => new SignalProtocolAddress(userId, RECOVERY_DEVICE_ID);

export interface RecoverCipher { mid: string; t: number; b: string }

/** Sender side: establish a FRESH recovery session to `peerUserId` and encrypt each item, binding it to
 * (messageId, chatId) inside the ciphertext. Returns per-message ciphertexts, or [] if the peer has no keys. */
export async function encryptRecovery(store: SignalStore, peerUserId: string, chatId: string, items: Array<{mid: string; text: string}>): Promise<RecoverCipher[]> {
    const {devices} = await fetchUserKeys(peerUserId);
    if (devices.length === 0) return [];
    const dev = devices[0];                         // 1:1 — first device
    const addr = recAddr(peerUserId);
    await store.deleteSession(addr.toString());     // FRESH — never ride a stalled chain
    const builder = new SessionBuilder(store, addr);
    await builder.processPreKey({
        registrationId: addrDeviceNum(dev.deviceId),
        identityKey: unb64(dev.identityKey),
        signedPreKey: {keyId: dev.signedPreKey.id, publicKey: unb64(dev.signedPreKey.publicKey), signature: unb64(dev.signedPreKey.signature)},
        preKey: dev.oneTimePreKey ? {keyId: dev.oneTimePreKey.id, publicKey: unb64(dev.oneTimePreKey.publicKey)} : undefined,
    });
    const cipher = new SessionCipher(store, addr);
    const out: RecoverCipher[] = [];
    for (const it of items) {
        const bound = JSON.stringify({v: 1, mid: it.mid, cid: chatId, t: it.text});   // binding is INSIDE the AEAD
        const msg = await cipher.encrypt(new TextEncoder().encode(bound).buffer);
        out.push({mid: it.mid, t: msg.type, b: b64(binaryStringToBuffer(msg.body ?? ""))});
    }
    return out;
}

/** Receiver side: decrypt recovery ciphertexts on the recovery session and VERIFY the binding. Returns
 * only items whose embedded (mid, cid) match the claim + the expected chat — a mislabelled item is dropped. */
export async function decryptRecovery(store: SignalStore, senderUserId: string, expectedChatId: string, items: RecoverCipher[]): Promise<Array<{mid: string; text: string}>> {
    const addr = recAddr(senderUserId);
    const cipher = new SessionCipher(store, addr);
    const out: Array<{mid: string; text: string}> = [];
    for (const it of items) {
        try {
            const body = bufferToBinaryString(unb64(it.b));
            const plain = it.t === 3
                ? await cipher.decryptPreKeyWhisperMessage(body, "binary")
                : await cipher.decryptWhisperMessage(body, "binary");
            const obj = JSON.parse(new TextDecoder().decode(plain)) as {mid?: string; cid?: string; t?: string};
            if (obj.cid !== expectedChatId || obj.mid !== it.mid || typeof obj.t !== "string") continue;   // binding check
            out.push({mid: it.mid, text: obj.t});
        } catch { /* undecryptable / tampered → skip */ }
    }
    // The recovery lane is one-shot: the sender tears down + re-X3DHs for the NEXT batch, so this session is
    // now dead. Drop it so the recovery address never accumulates archived states (bounded lane — #19).
    await store.deleteSession(addr.toString()).catch(() => {});
    return out;
}

// libsignal ciphertext bodies are binary STRINGS; convert to/from bytes for base64 transport.
function binaryStringToBuffer(s: string): ArrayBuffer {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b.buffer;
}
function bufferToBinaryString(buf: ArrayBuffer): string {
    const b = new Uint8Array(buf); let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
}
