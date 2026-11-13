import {plaintextStats} from "./atRest.ts";
import {allPending} from "../recovery/pendingStore.ts";

// The keys, the sessions and the "verified" marks are in the Android app's library; the interface can
// count only what it stores itself.
export const E2EE_PROTOCOL = "Signal: PQXDH + Double Ratchet";

export interface CryptoStats {
    secretMessages: number;       // locally-stored decrypted secret messages
    secretBytes: number;          // their on-disk (wrapped) size
    pendingRecovery: number;      // undelivered secret messages awaiting client-to-client recovery
    protocol: string;
}

/** Gather the E2EE diagnostics shown on the info page. Best-effort. */
export async function cryptoStats(): Promise<CryptoStats> {
    const [pt, pending] = await Promise.all([plaintextStats(), allPending()]);
    return {secretMessages: pt.count, secretBytes: pt.bytes, pendingRecovery: pending.length, protocol: E2EE_PROTOCOL};
}
