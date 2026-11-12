import {describe, it, expect, beforeEach} from "vitest";
import {formatSafetyNumber, markVerified, clearVerified, isVerified} from "../safetyNumber";

// The verified-state logic: verification is tied to the SPECIFIC safety number, so a later identity-key
// change (→ a different number) automatically drops verification and prompts a re-check. (The number itself
// is produced by the library's FingerprintGenerator, exercised in the crypto suite.)

beforeEach(() => localStorage.clear());

describe("safety number formatting", () => {
    it("groups the digits into readable 5-char chunks", () => {
        expect(formatSafetyNumber("1234567890123")).toBe("12345 67890 123");
    });
});

describe("verification state", () => {
    it("verified only while the current number matches the one that was verified", () => {
        expect(isVerified("bob", "111112222233333")).toBe(false);     // never verified
        markVerified("bob", "111112222233333");
        expect(isVerified("bob", "111112222233333")).toBe(true);      // matches → verified
        // Peer's identity key changed → a different safety number → auto-unverified.
        expect(isVerified("bob", "999998888877777")).toBe(false);
        expect(isVerified("bob", null)).toBe(false);                  // no session yet
    });

    it("clearVerified removes it", () => {
        markVerified("carol", "555556666677777");
        clearVerified("carol");
        expect(isVerified("carol", "555556666677777")).toBe(false);
    });
});
