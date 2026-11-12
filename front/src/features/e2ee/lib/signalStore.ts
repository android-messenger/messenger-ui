import {openDB, type IDBPDatabase} from "idb";
import type {StorageType, KeyPairType, SessionRecordType} from "@privacyresearch/libsignal-protocol-typescript";
import {wrapBytes, unwrapBytes, type Wrapped} from "./deviceKey.ts";
import {E2EE_DB} from "./stores.ts";

// IndexedDB-backed implementation of libsignal's StorageType. The library hands us ArrayBuffer key
// material and opaque session-record strings; we persist them with the SENSITIVE parts (private keys,
// session/ratchet state) WRAPPED under the device key, and the PUBLIC parts (public keys, peer identities
// for TOFU) in the clear. All private bytes are only ever unwrapped into memory when the ratchet uses them.
//
// Stores: meta (identity keypair + registrationId + deviceId) · prekeys · signedprekeys · sessions (ratchet
// state, wrapped) · peers (peer public identity keys, for trust-on-first-use).

const V = 2;
const META = "meta", PREKEYS = "prekeys", SIGNED = "signedprekeys", SESSIONS = "sessions", PEERS = "peers", ROSTER = "roster";

/** A cached snapshot of a peer's device roster: which devices to encrypt to, and when we learned it.
 * Lets the sender reuse established sessions WITHOUT re-fetching the directory on every send (which would
 * consume a one-time prekey each time). Invalidated by TTL, a rekey hint, or a local decrypt failure. */
export interface RosterSnapshot { deviceIds: string[]; fetchedAt: number }

/** Reserved prekey id for the REUSABLE last-resort prekey (served when a device's normal OPK pool is
 * exhausted). Max positive int32 so it never collides with the monotonic OPK ids (which start small). */
export const LAST_RESORT_PREKEY_ID = 0x7fffffff;

// A stored keypair: public half in the clear, private half wrapped.
interface StoredKeyPair { pub: ArrayBuffer; priv: Wrapped }
async function packKeyPair(kp: KeyPairType): Promise<StoredKeyPair> { return { pub: kp.pubKey, priv: await wrapBytes(kp.privKey) }; }
async function unpackKeyPair(s: StoredKeyPair | undefined): Promise<KeyPairType | undefined> {
    if (!s) return undefined;
    return { pubKey: s.pub, privKey: await unwrapBytes(s.priv) };
}

const enc = new TextEncoder(), dec = new TextDecoder();

export class SignalStore implements StorageType {
    // dbName is parameterized so tests can isolate two "devices"; prod uses the single default.
    private dbName: string;
    constructor(dbName: string = E2EE_DB.signal) { this.dbName = dbName; }
    private db(): Promise<IDBPDatabase> {
        const p: Promise<IDBPDatabase> = openDB(this.dbName, V, {
            upgrade(d) {
                for (const s of [META, PREKEYS, SIGNED, SESSIONS, PEERS, ROSTER]) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
            },
            // A wipe (logout) asks to delete this database: let go at once, or the deletion stays blocked.
            blocking() { void p.then((d) => d.close(), () => {}); },
        });
        return p;
    }

    // --- owner (spec 001, FR-006): whose keys these are. Plain value — reading it needs no Vault. ---
    async getOwner(): Promise<string | undefined> {
        return (await (await this.db()).get(META, "owner")) as string | undefined;
    }
    async setOwner(userId: string): Promise<void> {
        await (await this.db()).put(META, userId, "owner");
    }
    /**
     * Erases every key, session and remembered peer and keeps only whose data this is. For the Android
     * app after its move to the native library (spec 001, FR-058): nothing here is a key any more.
     */
    async dropKeys(): Promise<void> {
        const d = await this.db();
        const owner = await d.get(META, "owner");
        const tx = d.transaction([META, PREKEYS, SIGNED, SESSIONS, PEERS, ROSTER], "readwrite");
        for (const s of [META, PREKEYS, SIGNED, SESSIONS, PEERS, ROSTER]) await tx.objectStore(s).clear();
        if (owner !== undefined) await tx.objectStore(META).put(owner, "owner");
        await tx.done;
    }
    /** True when the store holds an identity — without unwrapping it (no Vault call). */
    async hasIdentity(): Promise<boolean> {
        return (await (await this.db()).getKey(META, "identity")) !== undefined;
    }

    // --- identity + registration (set once at provisioning) ---
    async setup(identity: KeyPairType, registrationId: number, deviceId: string): Promise<void> {
        const d = await this.db();
        await d.put(META, await packKeyPair(identity), "identity");
        await d.put(META, registrationId, "registrationId");
        await d.put(META, deviceId, "deviceId");
    }
    async getIdentityKeyPair(): Promise<KeyPairType | undefined> {
        return unpackKeyPair((await (await this.db()).get(META, "identity")) as StoredKeyPair | undefined);
    }
    async getLocalRegistrationId(): Promise<number | undefined> {
        return (await (await this.db()).get(META, "registrationId")) as number | undefined;
    }
    async getDeviceId(): Promise<string | undefined> {
        return (await (await this.db()).get(META, "deviceId")) as string | undefined;
    }

    // --- peer identities (TOFU) ---
    async isTrustedIdentity(): Promise<boolean> {
        // TOFU with re-pinning: accept both first contact AND a later identity change.
        // A peer that re-provisions (cleared storage / new device) publishes a NEW identity;
        // rejecting it here (returning false on change) would DEADLOCK — the stale side could
        // neither re-establish a session (send) nor accept the peer's new prekey (receive), and
        // messaging/safety-numbers would never recover. Instead we let the change through and
        // surface it out-of-band: `saveIdentity` returns whether the key changed (caller warns),
        // and the safety number shifts → any prior verification auto-drops → "re-verify" prompt.
        // The safety number, compared in person, is the real MITM check — not this in-band gate.
        return true;
    }
    async saveIdentity(addr: string, publicKey: ArrayBuffer): Promise<boolean> {
        const d = await this.db();
        const prev = (await d.get(PEERS, addr)) as ArrayBuffer | undefined;
        await d.put(PEERS, publicKey, addr);
        return !!prev && !b64eq(prev, publicKey);             // true = the identity CHANGED (caller warns)
    }
    async loadIdentityKey(addr: string): Promise<ArrayBuffer | undefined> {
        return (await (await this.db()).get(PEERS, addr)) as ArrayBuffer | undefined;
    }
    /** A peer's stored identity public key, by userId (PEERS are keyed "userId.deviceNum"). v1: first device. */
    async getPeerIdentity(userId: string): Promise<ArrayBuffer | undefined> {
        const d = await this.db();
        const keys = (await d.getAllKeys(PEERS)) as string[];
        const k = keys.find((key) => key.startsWith(userId + "."));
        return k ? ((await d.get(PEERS, k)) as ArrayBuffer | undefined) : undefined;
    }

    // --- one-time prekeys ---
    // The last-resort prekey uses a RESERVED id and is stored in META (not PREKEYS), so it never pollutes
    // the monotonic OPK id floor and libsignal cannot delete it: loadPreKey routes the reserved id to it and
    // removePreKey no-ops for it, keeping it REUSABLE across incoming prekey messages (the whole point).
    async loadPreKey(id: string | number): Promise<KeyPairType | undefined> {
        if (Number(id) === LAST_RESORT_PREKEY_ID) return this.getLastResortPreKey();
        return unpackKeyPair((await (await this.db()).get(PREKEYS, String(id))) as StoredKeyPair | undefined);
    }
    async storePreKey(id: string | number, kp: KeyPairType): Promise<void> {
        if (Number(id) === LAST_RESORT_PREKEY_ID) { await this.setLastResortPreKey(kp); return; }
        await (await this.db()).put(PREKEYS, await packKeyPair(kp), String(id));
    }
    async removePreKey(id: string | number): Promise<void> {
        if (Number(id) === LAST_RESORT_PREKEY_ID) return; // reusable — never delete on use
        await (await this.db()).delete(PREKEYS, String(id));
    }
    async countPreKeys(): Promise<number> { return (await this.db()).count(PREKEYS); }

    // --- last-resort prekey (reusable fallback; stored in META, keyed by a reserved id) ---
    async getLastResortPreKey(): Promise<KeyPairType | undefined> {
        return unpackKeyPair((await (await this.db()).get(META, "lastResort")) as StoredKeyPair | undefined);
    }
    async setLastResortPreKey(kp: KeyPairType): Promise<void> {
        await (await this.db()).put(META, await packKeyPair(kp), "lastResort");
    }

    /**
     * Allocate `count` fresh, strictly-increasing one-time-prekey ids and persist the new floor. Ids must
     * NEVER be reused for the life of the device: the directory keeps a published id's public key (insert
     * is ON CONFLICT DO NOTHING), so reissuing an id would leave the private we hold out of sync with the
     * public a peer fetches, and a prekey message under it would fail to decrypt. Older builds kept the
     * counter in a module variable that reset to 1 on every reload — this persists it. The floor is seeded
     * beyond any id already stored, so existing installs don't collide the first time this code runs.
     */
    async allocatePreKeyIds(count: number): Promise<number[]> {
        const d = await this.db();
        let floor = (await d.get(META, "nextPreKeyId")) as number | undefined;
        if (floor === undefined) {
            const keys = (await d.getAllKeys(PREKEYS)) as string[];
            let max = 0;
            for (const k of keys) { const n = parseInt(k, 10); if (Number.isFinite(n) && n > max) max = n; }
            floor = max + 1;
        }
        const ids: number[] = [];
        for (let i = 0; i < count; i++) ids.push(floor + i);
        await d.put(META, floor + count, "nextPreKeyId");
        return ids;
    }

    // --- signed prekeys ---
    async loadSignedPreKey(id: string | number): Promise<KeyPairType | undefined> {
        return unpackKeyPair((await (await this.db()).get(SIGNED, String(id))) as StoredKeyPair | undefined);
    }
    async storeSignedPreKey(id: string | number, kp: KeyPairType): Promise<void> {
        await (await this.db()).put(SIGNED, await packKeyPair(kp), String(id));
    }
    async removeSignedPreKey(id: string | number): Promise<void> { await (await this.db()).delete(SIGNED, String(id)); }

    // --- sessions (ratchet state — wrapped) ---
    async loadSession(addr: string): Promise<SessionRecordType | undefined> {
        const w = (await (await this.db()).get(SESSIONS, addr)) as Wrapped | undefined;
        if (!w) return undefined;
        return dec.decode(await unwrapBytes(w));
    }
    async storeSession(addr: string, record: SessionRecordType): Promise<void> {
        await (await this.db()).put(SESSIONS, await wrapBytes(enc.encode(record).buffer), addr);
    }
    /** Drop a session so the next handshake starts FRESH — used by recovery to avoid riding a stalled chain. */
    async deleteSession(addr: string): Promise<void> { await (await this.db()).delete(SESSIONS, addr); }

    /**
     * Prune stored PEER-IDENTITY entries for `userId`'s devices that are NOT in `keepAddrs`.
     * A peer that re-provisions (cleared storage / new device) gets a NEW device address, so its old
     * device's stored identity LINGERS. `getPeerIdentity` (find-first) could then return that stale key,
     * and the safety number computed against it never matches the peer's current one. Called on every
     * `ensureSessions` with the current roster's addresses so only live devices remain. Addresses are
     * "userId.deviceNum"; we scope the scan to this user's prefix so other peers are untouched. We prune
     * ONLY identities (PEERS): stale SESSIONS are inert (encrypt/decrypt only ever address the current
     * roster / envelope device) and the SESSIONS store also holds the recovery lane, which must survive.
     */
    async retainPeerDevices(userId: string, keepAddrs: Set<string>): Promise<void> {
        const d = await this.db();
        const prefix = userId + ".";
        const keys = (await d.getAllKeys(PEERS)) as string[];
        for (const k of keys) if (k.startsWith(prefix) && !keepAddrs.has(k)) await d.delete(PEERS, k);
    }

    // --- peer roster cache (sender-side; avoids a directory fetch + OPK spend per send) ---
    /** The cached device roster for a peer, or undefined if none is cached. */
    async getRosterSnapshot(userId: string): Promise<RosterSnapshot | undefined> {
        return (await (await this.db()).get(ROSTER, userId)) as RosterSnapshot | undefined;
    }
    /** Cache the peer's device roster with the current timestamp. */
    async putRosterSnapshot(userId: string, deviceIds: string[]): Promise<void> {
        await (await this.db()).put(ROSTER, {deviceIds: [...deviceIds], fetchedAt: Date.now()} as RosterSnapshot, userId);
    }
    /** Drop the cached roster for a peer so the next send re-resolves from the directory (keeps sessions). */
    async deleteRosterSnapshot(userId: string): Promise<void> {
        await (await this.db()).delete(ROSTER, userId);
    }

    // --- wipe (logout) ---
    async clear(): Promise<void> {
        const d = await this.db();
        for (const s of [META, PREKEYS, SIGNED, SESSIONS, PEERS, ROSTER]) await d.clear(s);
    }
}

function b64eq(a: ArrayBuffer, b: ArrayBuffer): boolean {
    const x = new Uint8Array(a), y = new Uint8Array(b);
    if (x.length !== y.length) return false;
    let diff = 0; for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];  // constant-time-ish
    return diff === 0;
}
