// Public API of the E2EE feature. Consumers import from here (and the stateless helpers from ./wire.ts),
// not the internal lib modules. Encryption itself is five operations: `secretCrypto` (./crypto.ts).
export {fetchTurnCredentials, type TurnCreds} from "./lib/keyDirectory.ts";
export {secretCrypto, type SecretCrypto, type PeerState, type PeerTrust} from "./crypto.ts";
export {e2eeRecoveryMiddleware, reportUndecryptable} from "./recovery/e2eeRecoveryMiddleware.ts";
export {savePlaintext, loadPlaintext, deletePlaintextForChat, plaintextChatIds, sweepExpired, E2EE_PLAINTEXT_TTL_MS} from "./lib/atRest.ts";
export {formatSafetyNumber} from "./lib/safetyNumber.ts";
export {cryptoStats, type CryptoStats} from "./lib/cryptoStats.ts";
export {wipeE2eeData, finishPendingE2eeWipe, removeFromKeyDirectory, ensureE2eeOwner} from "./lib/wipe.ts";

import {ensureProvisioned, maybeReplenish, republishCurrentDevice} from "./lib/provisioning.ts";
import {selfCount} from "./lib/keyDirectory.ts";
import {SignalStore} from "./lib/signalStore.ts";
import {sweepExpired, E2EE_PLAINTEXT_TTL_MS} from "./lib/atRest.ts";
import {logger} from "@/shared/logger/logger.ts";

// Arm the disappearing-messages sweep: purge locally-stored decrypted plaintext older than the TTL, on
// app start and then hourly. Best-effort; idempotent. Started once from provisionE2EEInBackground.
let sweepTimer: ReturnType<typeof setInterval> | null = null;
function armPlaintextSweep(): void {
    void sweepExpired(E2EE_PLAINTEXT_TTL_MS).catch(() => {});
    if (!sweepTimer) sweepTimer = setInterval(() => { void sweepExpired(E2EE_PLAINTEXT_TTL_MS).catch(() => {}); }, 60 * 60 * 1000);
}

// Replenish-on-demand: our one-time-prekey pool is drained by OTHERS fetching us, which we're never
// notified about — so we poll our own remaining count and top up when it's low, not only at startup. This
// keeps the pool from sitting exhausted (peers then fall back to signed-prekey-only) between launches.
const REPLENISH_CHECK_MS = 30 * 60 * 1000;   // 30 min
async function checkReplenish(store: SignalStore, deviceId: string): Promise<void> {
    try {
        const {oneTimePreKeysRemaining} = await selfCount(deviceId);
        await maybeReplenish(deviceId, oneTimePreKeysRemaining, store);
    } catch { /* directory unreachable → next tick */ }
}
let replenishArmed = false;
function armReplenishCheck(store: SignalStore, deviceId: string): void {
    // Idempotent: provisionE2EEInBackground can run again (RequireAuth remount / re-login), so attach the
    // timer AND the visibility listener exactly once — an unguarded addEventListener leaked a listener per
    // call, each firing a redundant selfCount+replenish on every tab focus.
    if (replenishArmed) return;
    replenishArmed = true;
    setInterval(() => { void checkReplenish(store, deviceId); }, REPLENISH_CHECK_MS);
    try {
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") void checkReplenish(store, deviceId);
        });
    } catch { /* no document (SSR/tests) */ }
}

/**
 * Fire-and-forget: make sure this device has published its E2EE keys to the directory, and top up the
 * one-time-prekey pool if it's low. Called once after login. FULLY best-effort — any failure (directory
 * down, WebCrypto unavailable, storage blocked) is swallowed so it can NEVER affect login or the app.
 * Publishes PUBLIC keys only; nothing user-visible. Readies the directory for secret chats (later phases).
 */
export function provisionE2EEInBackground(): void {
    // Ask the browser to keep our storage PERSISTENT so it isn't evicted under pressure — eviction would
    // wipe the device key + Signal identity + at-rest secret plaintext (unrecoverable; normal history
    // re-syncs from the server, secret history does not). Best-effort; a no-op where unsupported/denied.
    try { void navigator.storage?.persist?.(); } catch { /* ignore */ }
    armPlaintextSweep();   // disappearing-messages GC (7-day TTL)
    void (async () => {
        try {
            const {store, deviceId, provisioned} = await ensureProvisioned();
            armReplenishCheck(store, deviceId);   // poll our remaining OPKs and top up on demand
            if (!provisioned) {
                // Already provisioned earlier. TOUCH this device so the directory keeps it fresh: the
                // stale-device GC is keep-newest (prunes a device only if older than the TTL AND the user
                // has a newer one), so a touch-on-start bumps updated_at and rotates the signed prekey,
                // keeping the ACTIVE browser out of the GC. The directory serves ALL of a user's devices
                // (encrypt-to-all), so this no longer "asserts current" — it only keeps this one live.
                // Then top up the OPK pool if it's low.
                try {
                    const remaining = await republishCurrentDevice(store, deviceId);
                    await maybeReplenish(deviceId, remaining, store);
                } catch { /* directory unreachable → try again next login */ }
            }
        } catch (e) {
            logger.debug("e2ee background provisioning skipped (best-effort)", e as Error);
        }
    })();
}
