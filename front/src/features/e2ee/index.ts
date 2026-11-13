// Public API of the E2EE feature. Consumers import from here (and the stateless helpers from ./wire.ts),
// not the internal lib modules. Encryption itself is the operations of `secretCrypto` (./crypto.ts).
export {fetchTurnCredentials, type TurnCreds} from "./lib/turn.ts";
export {secretCrypto, secretAvailable, type SecretCrypto, type PeerState, type PeerTrust} from "./crypto.ts";
export {e2eeRecoveryMiddleware, reportUndecryptable} from "./recovery/e2eeRecoveryMiddleware.ts";
export {savePlaintext, loadPlaintext, deletePlaintextForChat, plaintextChatIds, sweepExpired, E2EE_PLAINTEXT_TTL_MS} from "./lib/atRest.ts";
export {formatSafetyNumber} from "./lib/safetyNumber.ts";
export {cryptoStats, type CryptoStats} from "./lib/cryptoStats.ts";
export {wipeE2eeData, finishPendingE2eeWipe, removeFromKeyDirectory, ensureE2eeOwner} from "./lib/wipe.ts";
export {KeyChangeLine} from "./ui/KeyChangeLine.tsx";

import {sweepExpired, E2EE_PLAINTEXT_TTL_MS} from "./lib/atRest.ts";
import {isNativeApp} from "@/shared/platform.ts";
import {dropInterfaceKeys} from "./lib/wipe.ts";

// Disappearing messages: purge locally-stored decrypted text older than the TTL, on start and then hourly.
let sweepTimer: ReturnType<typeof setInterval> | null = null;
function armPlaintextSweep(): void {
    void sweepExpired(E2EE_PLAINTEXT_TTL_MS).catch(() => {});
    if (!sweepTimer) sweepTimer = setInterval(() => { void sweepExpired(E2EE_PLAINTEXT_TTL_MS).catch(() => {}); }, 60 * 60 * 1000);
}

/**
 * Called once after login, in the Android app and in a browser. Fire-and-forget, never affects login.
 * The interface publishes no keys: the app's library publishes them and keeps the one-time keys topped up.
 * Here only the housekeeping of what the interface stores itself.
 */
export function startE2eeUpkeep(): void {
    if (!isNativeApp()) return;   // a browser stores no secret-chat data
    // Ask for persistent storage, so the stored texts of secret messages are not evicted under pressure.
    try { void navigator.storage?.persist?.(); } catch { /* ignore */ }
    armPlaintextSweep();
    void dropInterfaceKeys();     // keys an older version of the interface kept itself
}
