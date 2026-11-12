import {ensureProvisioned} from "./provisioning.ts";
import {encryptTo, decryptFrom, type SecretEnvelope} from "./secretSession.ts";
import {b64, unb64} from "./deviceKey.ts";
import {MARKER, isSecretEnvelope} from "./envelope.ts";

export {isSecretEnvelope};

// The orchestration seam the message path calls. Wraps the crypto engine with:
//  - a wire MARKER so the receiver recognizes an E2EE body inside the opaque payload.body,
//  - a SINGLE-WRITER lock so the Double Ratchet is never advanced from two places at once (two tabs / SW),
//  - fail-closed semantics: a secret send that can't encrypt THROWS (the caller must not send plaintext).

const dec = new TextDecoder(), enc = new TextEncoder();

// Single-writer serialization of ratchet access. Prefer the Web Locks API (cross-tab); fall back to an
// in-process promise chain when it's unavailable (older browsers, tests, SSR).
let chain: Promise<unknown> = Promise.resolve();
function withRatchetLock<T>(fn: () => Promise<T>): Promise<T> {
    const locks = (typeof navigator !== "undefined" ? navigator.locks : undefined);
    if (locks?.request) return locks.request("wolp-e2ee-ratchet", fn) as Promise<T>;
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
}

/**
 * Encrypt `text` for `peerUserId` and return the WIRE body (marker + base64 envelope) to put in
 * payload.body. THROWS on any failure — the caller MUST fail closed (never fall back to plaintext for a
 * secret chat). Provisioning is ensured lazily so a first secret message just works.
 */
export function encryptForSend(peerUserId: string, text: string): Promise<string> {
    return withRatchetLock(async () => {
        const {store, deviceId} = await ensureProvisioned();
        const env = await encryptTo(store, peerUserId, deviceId, text);
        return MARKER + b64(enc.encode(JSON.stringify(env)).buffer);
    });
}

/**
 * Decrypt a received E2EE wire body from `senderUserId`. THROWS if it isn't an envelope, has nothing for
 * this device, or is a duplicate/replay (message key already consumed) — the caller renders a placeholder.
 */
export function decryptReceived(senderUserId: string, body: string): Promise<string> {
    return withRatchetLock(async () => {
        if (!isSecretEnvelope(body)) throw new Error("e2ee: not an envelope");
        const env = JSON.parse(dec.decode(unb64(body.slice(MARKER.length)))) as SecretEnvelope;
        const {store, deviceId} = await ensureProvisioned();
        return decryptFrom(store, senderUserId, deviceId, env);
    });
}
