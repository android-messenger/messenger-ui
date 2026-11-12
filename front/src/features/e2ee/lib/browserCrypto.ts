import type {PeerState, SecretCrypto} from "../crypto.ts";
import {encryptRecovery, decryptRecovery, invalidatePeer} from "./secretSession.ts";
import {encryptForSend, decryptReceived} from "./secretChat.ts";
import {computeSafetyNumber, markVerified, clearVerified, isVerified} from "./safetyNumber.ts";
import {ensureProvisioned} from "./provisioning.ts";

// The browser implementation of the encryption module: the JavaScript code as it was, behind the five
// operations. No passport and no key-change flag here — those exist only in the Android app.

/** The safety number with the peer, for the user who owns the keys on this device. */
async function numberWith(peerUserId: string): Promise<string | null> {
    try {
        const {store} = await ensureProvisioned();
        const me = await store.getOwner();
        return me ? await computeSafetyNumber(me, peerUserId) : null;
    } catch { return null; }
}

export const browserCrypto: SecretCrypto = {
    encrypt: (peerUserId, text) => encryptForSend(peerUserId, text),
    decrypt: (peerUserId, body) => decryptReceived(peerUserId, body),

    async peerState(peerUserId): Promise<PeerState> {
        const verified = isVerified(peerUserId, await numberWith(peerUserId));
        return {trust: verified ? "verified" : "unverified", keyChanged: false};
    },

    safetyNumber: (peerUserId) => numberWith(peerUserId),

    async setVerified(peerUserId, verified) {
        if (!verified) { clearVerified(peerUserId); return; }
        const n = await numberWith(peerUserId);
        if (!n) throw new Error("e2ee: no safety number to verify");
        markVerified(peerUserId, n);
    },

    async resetSession(peerUserId) {
        const {store} = await ensureProvisioned();
        await invalidatePeer(store, peerUserId);
    },

    async encryptRecovery(peerUserId, chatId, items) {
        const {store} = await ensureProvisioned();
        return encryptRecovery(store, peerUserId, chatId, items);
    },

    async decryptRecovery(peerUserId, chatId, items) {
        const {store} = await ensureProvisioned();
        return decryptRecovery(store, peerUserId, chatId, items);
    },
};
