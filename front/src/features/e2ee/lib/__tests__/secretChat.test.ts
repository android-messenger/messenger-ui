import {describe, it, expect} from "vitest";
import {isSecretEnvelope} from "../secretChat";

// The receive path uses isSecretEnvelope to tell an E2EE body apart from plaintext inside payload.body.
// (Full encrypt/decrypt is covered end-to-end in secretSession.test.) Marker detection must be exact so a
// plaintext message that merely mentions "E2EE" is never mistaken for ciphertext.
describe("isSecretEnvelope", () => {
    it("recognizes the E2EE1: marker prefix", () => {
        expect(isSecretEnvelope("E2EE1:abc123")).toBe(true);
    });
    it("treats plaintext (incl. text merely containing the word) as NOT an envelope", () => {
        expect(isSecretEnvelope("hello world")).toBe(false);
        expect(isSecretEnvelope("we use E2EE1: here")).toBe(false);   // marker only counts at the START
        expect(isSecretEnvelope("")).toBe(false);
        expect(isSecretEnvelope(undefined)).toBe(false);
    });
});
