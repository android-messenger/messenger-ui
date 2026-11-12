// The ONE encryption module of secret chats (spec 001, story 6, FR-050). Chat and call code reach keys and
// sessions only through these five operations — none of them returns a key or signs caller-supplied data.
//
// Two implementations (FR-051): the browser one (lib/browserCrypto.ts — the current JavaScript code, test
// builds only) and, in the app, the native bridge (not built yet). Which one is used is decided here.

import {browserCrypto} from "./lib/browserCrypto.ts";

/** How far the peer's key has been checked. "passport" exists only behind the native bridge. */
export type PeerTrust = "unverified" | "passport" | "verified";

export interface PeerState {
    trust: PeerTrust;
    /** The peer's key changed since the user last looked. The browser implementation never sets it: there a
     *  key change just drops the "verified" mark. */
    keyChanged: boolean;
}

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
}

export const secretCrypto: SecretCrypto = browserCrypto;
