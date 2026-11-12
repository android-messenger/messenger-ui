import type {PeerState, RecoverCipher, SecretCrypto} from "../crypto.ts";
import {deviceTrust} from "@/shared/platform.ts";
import {vaultCall} from "./deviceKey.ts";
import {refusalCode} from "./failure.ts";
import {dismissKeyChanged, noteKeyChanged} from "./keyChange.ts";
import {makeThrottle, REKEY_COALESCE_MS} from "./rekeyHint.ts";

// The Android app's implementation of the encryption module (spec 001, story 6): every operation is a call
// to the app's bridge. The keys, the sessions, the remembered keys of peers and the "verified" marks live
// in the app's library (wolp-device-trust spec 002); this code never sees a key (FR-052). The library also
// publishes this device's keys and takes the peers' keys from the key directory itself.
//
// A locked phone answers `locked`: the call waits for the unlock and runs again, as the Vault calls do.

/** At most one session reset per peer per window: a forged recovery request costs one directory fetch. */
const resetThrottle = makeThrottle(REKEY_COALESCE_MS);

/** The library keeps "the key changed" until the user closes the notice; the chat shows what it says. */
async function readState(peer: string): Promise<PeerState> {
    const s = await vaultCall(() => deviceTrust().e2eePeerState({peer}));
    if (s.keyChanged || s.trust === "reverify") noteKeyChanged(peer);
    else dismissKeyChanged(peer);
    return {trust: s.trust, keyChanged: s.keyChanged};
}
function watchKey(peer: string): void { void readState(peer).catch(() => { /* shown with the next message */ }); }

/** A recovered message travels as an ordinary envelope whose text names what it replaces. */
interface Recovered { wolpRecovery: 1; mid: string; chatId: string; text: string }

export const bridgeCrypto: SecretCrypto = {
    async encrypt(peer, text) {
        try {
            const {envelope} = await vaultCall(() => deviceTrust().e2eeEncrypt({peer, text}));
            watchKey(peer);
            return envelope;
        } catch (e) {
            if (refusalCode(e) === "reverify") noteKeyChanged(peer);
            throw e;
        }
    },

    async decrypt(peer, envelope) {
        try {
            const {text} = await vaultCall(() => deviceTrust().e2eeDecrypt({peer, envelope}));
            watchKey(peer);
            return text;
        } catch (e) {
            if (refusalCode(e) !== "duplicate") watchKey(peer);   // a first message with a new key may be the one that failed
            throw e;
        }
    },

    peerState: readState,

    async safetyNumber(peer) {
        const {digits} = await vaultCall(() => deviceTrust().e2eeSafetyNumber({peer}));
        return digits ?? null;
    },

    async setVerified(peer, verified, shownNumber) {
        try {
            await vaultCall(() => deviceTrust().e2eeSetVerified({peer, verified, digits: shownNumber}));
        } catch (e) {
            if (refusalCode(e) === "reverify") noteKeyChanged(peer);
            throw e;
        }
        watchKey(peer);
    },

    async keyChangeSeen(peer) {
        await vaultCall(() => deviceTrust().e2eeKeyChangeSeen({peer}));
        watchKey(peer);   // a peer still to be verified again keeps its line
    },

    async resetSession(peer) {
        if (!resetThrottle(peer)) return;
        await vaultCall(() => deviceTrust().e2eeResetSession({peer}));
    },

    /** The requester could not read these: start a new session and encrypt them again in it. */
    async encryptRecovery(peer, chatId, items) {
        await this.resetSession(peer);
        const out: RecoverCipher[] = [];
        for (const {mid, text} of items) {
            const body: Recovered = {wolpRecovery: 1, mid, chatId, text};
            const {envelope} = await vaultCall(() => deviceTrust().e2eeEncrypt({peer, text: JSON.stringify(body)}));
            out.push({mid, t: 0, b: envelope});
        }
        return out;
    },

    /** Each item must name the message and the chat it was asked for; anything else is dropped. */
    async decryptRecovery(peer, chatId, items) {
        const out: Array<{mid: string; text: string}> = [];
        for (const it of items) {
            try {
                const {text} = await vaultCall(() => deviceTrust().e2eeDecrypt({peer, envelope: it.b}));
                const r = JSON.parse(text) as Partial<Recovered>;
                if (r.wolpRecovery === 1 && r.mid === it.mid && r.chatId === chatId && typeof r.text === "string") out.push({mid: it.mid, text: r.text});
            } catch { /* this item stays pending and is asked for again */ }
        }
        watchKey(peer);
        return out;
    },
};
