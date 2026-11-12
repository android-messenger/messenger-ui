import {FingerprintGenerator} from "@privacyresearch/libsignal-protocol-typescript";
import {ensureProvisioned} from "./provisioning.ts";
import {b64} from "./deviceKey.ts";
import {E2EE_LS} from "./stores.ts";

// Safety numbers (Signal's out-of-band MITM check). A fingerprint derived from BOTH parties' public
// identity keys — identical on both sides IFF neither key was substituted by the (trusted) key directory
// or a man in the middle. Users compare it out-of-band (in person / call) and mark the peer verified.
// A later identity-key change makes the number change → verification auto-drops → "re-verify" prompt.

// Fingerprint work factor. Signal's spec is 5200, but this pure-JS implementation runs that many hash
// rounds SEQUENTIALLY → several seconds (the modal looked stuck). 1024 is effectively instant and, since
// BOTH clients run this same constant, the two safety numbers still match. Not interoperable with Signal
// itself — which we don't need.
const ITERATIONS = 1024;

/** The safety number for the current user ↔ peerUserId, or null if the peer's identity isn't known yet
 * (no secret session established). Symmetric — both sides compute the same string. */
const numCache = new Map<string, string>();   // cacheKey (peer + both identity fingerprints) → number

export async function computeSafetyNumber(myUserId: string, peerUserId: string): Promise<string | null> {
    try {
        const {store} = await ensureProvisioned();
        const mine = await store.getIdentityKeyPair();
        const theirs = await store.getPeerIdentity(peerUserId);
        if (!mine || !theirs) return null;
        // The number is deterministic in the two identity keys — cache it (the 1024-round hash is otherwise
        // recomputed on every open, ~half a second). The key includes both identities so a key CHANGE busts it.
        const cacheKey = `${peerUserId}:${b64(mine.pubKey).slice(0, 22)}:${b64(theirs).slice(0, 22)}`;
        const hit = numCache.get(cacheKey);
        if (hit) return hit;
        const fp = new FingerprintGenerator(ITERATIONS);
        // Order the two ids so both sides produce the SAME number regardless of who computes it.
        const [a, ak, b, bk] = myUserId < peerUserId
            ? [myUserId, mine.pubKey, peerUserId, theirs]
            : [peerUserId, theirs, myUserId, mine.pubKey];
        const num = await fp.createFor(a, ak, b, bk);
        numCache.set(cacheKey, num);
        return num;
    } catch { return null; }
}

/** Group the raw fingerprint into readable 5-digit chunks (e.g. "12345 67890 …"). */
export function formatSafetyNumber(n: string): string {
    return (n.match(/.{1,5}/g) ?? [n]).join(" ");
}

// --- verification state (localStorage; keyed by peer, remembers the VERIFIED number so a key change
//     automatically un-verifies) ---
const KEY = E2EE_LS.verified;
function load(): Record<string, string> {
    try { const r = localStorage.getItem(KEY); return r ? JSON.parse(r) : {}; } catch { return {}; }
}
function save(m: Record<string, string>): void {
    try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* ignore */ }
}
/** Mark this peer verified for the given (current) safety number. */
export function markVerified(peerUserId: string, safetyNumber: string): void {
    const m = load(); m[peerUserId] = safetyNumber; save(m);
}
export function clearVerified(peerUserId: string): void {
    const m = load(); delete m[peerUserId]; save(m);
}
/** Verified IFF a number was stored AND it still matches the current one (else key changed → re-verify). */
export function isVerified(peerUserId: string, currentSafetyNumber: string | null): boolean {
    if (!currentSafetyNumber) return false;
    return load()[peerUserId] === currentSafetyNumber;
}
