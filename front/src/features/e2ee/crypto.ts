// The ONE encryption module of secret chats (spec 001, story 6, FR-050). Chat and call code reach keys and
// sessions only through these operations — none of them returns a key or signs caller-supplied data.
//
// Two implementations (FR-051): in the Android app — the app's bridge (lib/bridgeCrypto.ts; keys and
// sessions live in the app's library); in a browser — the JavaScript code (lib/browserCrypto.ts, for
// debugging only). The two do not understand each other: a browser and a phone cannot hold a secret chat.

import {isNativeApp} from "@/shared/platform.ts";
import {browserCrypto} from "./lib/browserCrypto.ts";
import {bridgeCrypto} from "./lib/bridgeCrypto.ts";

/** How far the peer's key has been checked. "passport" and "reverify" exist only in the app:
 *  "reverify" — the peer was compared by safety number and then changed the key; sending is refused
 *  until the user compares again or takes the mark off. */
export type PeerTrust = "unverified" | "passport" | "verified" | "reverify";

export interface PeerState {
    trust: PeerTrust;
    /** The peer's key changed since the user last looked. The browser implementation never sets it: there a
     *  key change just drops the "verified" mark. */
    keyChanged: boolean;
}

/** One message re-encrypted for recovery: `mid` — the client id it replaces. */
export interface RecoverCipher { mid: string; t: number; b: string }

export interface SecretCrypto {
    /** Encrypt `text` for the peer → the wire body. THROWS when it cannot: the caller must not send plaintext. */
    encrypt(peerUserId: string, text: string): Promise<string>;
    /** Decrypt a wire body from the peer. THROWS on anything it cannot read, a replay included. */
    decrypt(peerUserId: string, body: string): Promise<string>;
    peerState(peerUserId: string): Promise<PeerState>;
    /** Digits to compare out of band, or null while the peer's key is not known. */
    safetyNumber(peerUserId: string): Promise<string | null>;
    /** Mark the peer as compared by safety number, or take the mark off. */
    setVerified(peerUserId: string, verified: boolean): Promise<void>;
    /** Message recovery: the next encrypt takes the peer's keys from the directory again. */
    resetSession(peerUserId: string): Promise<void>;
    /** Re-encrypt own stored messages the peer could not read, each bound to its id and chat. */
    encryptRecovery(peerUserId: string, chatId: string, items: Array<{mid: string; text: string}>): Promise<RecoverCipher[]>;
    /** The counterpart of encryptRecovery; items that do not check out are left out. */
    decryptRecovery(peerUserId: string, chatId: string, items: RecoverCipher[]): Promise<Array<{mid: string; text: string}>>;
}

export const secretCrypto: SecretCrypto = isNativeApp() ? bridgeCrypto : browserCrypto;
