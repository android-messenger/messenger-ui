// The ONE encryption module of secret chats (spec 001, story 6, FR-050). Chat and call code reach keys and
// sessions only through these operations — none of them returns a key or signs caller-supplied data.
//
// The implementation is the Android app's bridge (lib/bridgeCrypto.ts): keys and sessions live in the
// app's library. A browser has none: there every operation that needs a key is refused with `app_only`
// (lib/appOnlyCrypto.ts) — secret chats and calls work only in the app.

import {isNativeApp} from "@/shared/platform.ts";
import {appOnlyCrypto} from "./lib/appOnlyCrypto.ts";
import {bridgeCrypto} from "./lib/bridgeCrypto.ts";

/** How far the peer's key has been checked.
 *  "reverify" — the peer was compared by safety number and then changed the key; sending is refused
 *  until the user compares again or takes the mark off. */
export type PeerTrust = "unverified" | "passport" | "verified" | "reverify";

export interface PeerState {
    trust: PeerTrust;
    /** The peer's key changed and the user has not closed the notice yet (keyChangeSeen) nor compared the
     *  number again. */
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
    /** Mark the peer as compared by safety number, or take the mark off. `shownNumber` — the digits that were
     *  on the screen: the mark goes to that key only, and THROWS (`reverify` in the app) when the peer's key
     *  is another one by now. */
    setVerified(peerUserId: string, verified: boolean, shownNumber: string): Promise<void>;
    /** The user closed the "key changed" notice. */
    keyChangeSeen(peerUserId: string): Promise<void>;
    /** Message recovery: the next encrypt takes the peer's keys from the directory again. */
    resetSession(peerUserId: string): Promise<void>;
    /** Re-encrypt own stored messages the peer could not read, each bound to its id and chat. */
    encryptRecovery(peerUserId: string, chatId: string, items: Array<{mid: string; text: string}>): Promise<RecoverCipher[]>;
    /** The counterpart of encryptRecovery; items that do not check out are left out. */
    decryptRecovery(peerUserId: string, chatId: string, items: RecoverCipher[]): Promise<Array<{mid: string; text: string}>>;
}

/** True where secret chats and calls work: in the Android app. */
export function secretAvailable(): boolean { return isNativeApp(); }

export const secretCrypto: SecretCrypto = secretAvailable() ? bridgeCrypto : appOnlyCrypto;
