import {getDeviceKeyCreatedAt} from "./deviceKey.ts";
import {E2EE_LS} from "./stores.ts";
import {plaintextStats} from "./atRest.ts";
import {allPending} from "../recovery/pendingStore.ts";

export const E2EE_LIB_VERSION = "libsignal-protocol-typescript 0.0.16";
export const E2EE_PROTOCOL = "X3DH + Double Ratchet";
export const E2EE_ENVELOPE_VERSION = 1;

export interface CryptoStats {
    deviceKeyCreatedAt: number;   // when the master/device key was made (epoch ms; 0 = none)
    secretMessages: number;       // locally-stored decrypted secret messages
    secretBytes: number;          // their on-disk (wrapped) size
    pendingRecovery: number;      // undelivered secret messages awaiting client-to-client recovery
    verifiedContacts: number;
    lib: string;
    protocol: string;
    envelope: number;
}

/** Gather the E2EE diagnostics shown on the info page. Best-effort. */
export async function cryptoStats(): Promise<CryptoStats> {
    const [deviceKeyCreatedAt, pt, pending] = await Promise.all([getDeviceKeyCreatedAt(), plaintextStats(), allPending()]);
    let verifiedContacts = 0;
    try { verifiedContacts = Object.keys(JSON.parse(localStorage.getItem(E2EE_LS.verified) || "{}")).length; } catch { /* ignore */ }
    return {
        deviceKeyCreatedAt,
        secretMessages: pt.count,
        secretBytes: pt.bytes,
        pendingRecovery: pending.length,
        verifiedContacts,
        lib: E2EE_LIB_VERSION,
        protocol: E2EE_PROTOCOL,
        envelope: E2EE_ENVELOPE_VERSION,
    };
}
