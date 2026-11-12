import {describe, it, expect} from "vitest";
import {
    MAX_SKIP_PER_CHAIN, classifyDecryptError, isRecoverable, isWrongDevice, secretStateKey,
    type DecryptFailure, type SecretMsgState,
} from "../failure";

describe("failure taxonomy", () => {
    it("pins the library's hard skip ceiling", () => {
        expect(MAX_SKIP_PER_CHAIN).toBe(2000);   // matches session-cipher.js "Over 2000 messages into the future!"
    });

    it("classifies the real libsignal error messages", () => {
        const cases: Array<[string, DecryptFailure]> = [
            ["Over 2000 messages into the future!", "hard-gap"],
            ["Message key not found. The counter was repeated or the key was not filled.", "hard-gap"],
            ["No record for device", "no-session"],
            ["No session to decrypt with", "no-session"],
            ["Identity key changed", "no-session"],
            ["e2ee: not an envelope", "corrupt"],
            ["Unexpected token < in JSON at position 0", "corrupt"],
            ["e2ee: envelope has no ciphertext for this device", "wrong-device"],
            ["something totally unexpected", "unknown"],
        ];
        for (const [msg, want] of cases) {
            expect(classifyDecryptError(new Error(msg)), msg).toBe(want);
        }
    });

    it("accepts a non-Error too (never throws on odd input)", () => {
        expect(classifyDecryptError("into the future")).toBe("hard-gap");
        expect(classifyDecryptError(null)).toBe("unknown");
        expect(classifyDecryptError(undefined)).toBe("unknown");
    });

    it("marks hard-gap / no-session / wrong-device / unknown as recoverable, but never corrupt or duplicate", () => {
        expect(isRecoverable("hard-gap")).toBe(true);
        expect(isRecoverable("no-session")).toBe(true);
        expect(isRecoverable("wrong-device")).toBe(true);
        expect(isRecoverable("unknown")).toBe(true);
        expect(isRecoverable("corrupt")).toBe(false);
        expect(isRecoverable("duplicate")).toBe(false);
    });

    it("flags only wrong-device for a rekey hint", () => {
        expect(isWrongDevice("wrong-device")).toBe(true);
        for (const f of ["hard-gap", "no-session", "duplicate", "corrupt", "unknown"] as DecryptFailure[]) {
            expect(isWrongDevice(f)).toBe(false);
        }
    });

    it("maps every visible state to a stable i18n key", () => {
        const map: Record<SecretMsgState, string> = {
            decrypting: "chat.decrypting",
            pending: "chat.decryptPending",
            expired: "chat.decryptExpired",
            lost: "chat.decryptLost",
            unavailable: "chat.decryptUnavailable",
        };
        for (const [state, key] of Object.entries(map)) {
            expect(secretStateKey(state as SecretMsgState)).toBe(key);
        }
    });
});
