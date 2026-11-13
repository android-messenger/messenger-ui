import type {SecretCrypto} from "../crypto.ts";

// A browser has no encryption module: the keys of secret chats live only in the Android app's library.
// Every operation that would need a key is refused with `app_only`; the chat and the call tell the user
// that secret chats and calls work only in the app. Nothing is sent in the clear instead.

export const APP_ONLY = "app_only";

function refuse(): never {
    throw Object.assign(new Error("e2ee: only in the Android app"), {code: APP_ONLY});
}

export const appOnlyCrypto: SecretCrypto = {
    async encrypt() { return refuse(); },
    async decrypt() { return refuse(); },
    async peerState() { return {trust: "unverified", keyChanged: false}; },
    async safetyNumber() { return null; },
    async setVerified() { refuse(); },
    async keyChangeSeen() { /* a browser keeps no such mark */ },
    async resetSession() { /* no sessions here */ },
    async encryptRecovery() { return []; },
    async decryptRecovery() { return []; },
};
