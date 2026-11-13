import {describe, it, expect} from "vitest";
import {
    classifyDecryptError, refusalCode, sendFailureKey, isRecoverable, isWrongDevice, secretStateKey,
    type DecryptFailure, type SecretMsgState,
} from "../failure";

describe("failure taxonomy", () => {
    it("a browser's refusal is told to the user and never turns into a recovery request", () => {
        const e = Object.assign(new Error("e2ee: only in the Android app"), {code: "app_only"});
        expect(refusalCode(e)).toBe("app_only");
        expect(sendFailureKey(e)).toBe("chat.appOnly");
        expect(classifyDecryptError(e)).toBe("app-only");
        expect(isRecoverable("app-only")).toBe(false);
    });

    it("the user is told why a secret message was not sent", () => {
        const refused = (code: string) => Object.assign(new Error("e2ee encrypt refused"), {code});
        expect(sendFailureKey(refused("no_passport"))).toBe("chat.peerNotInApp");
        expect(sendFailureKey(refused("no_device"))).toBe("chat.peerNoKeys");
        expect(sendFailureKey(refused("bad_passport"))).toBe("chat.peerKeyRejected");
        expect(sendFailureKey(new Error("anything else"))).toBe("chat.encryptFailed");
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
            appOnly: "chat.secretAppOnly",
        };
        for (const [state, key] of Object.entries(map)) {
            expect(secretStateKey(state as SecretMsgState)).toBe(key);
        }
    });
});
