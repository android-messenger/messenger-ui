import {describe, it, expect} from "vitest";
import {REKEY_HINT, buildRekeyHint, makeThrottle} from "../rekeyHint";

describe("rekey hint", () => {
    it("builds a metadata-only frame (no key material, no device id)", () => {
        const f = buildRekeyHint("peer-123", "chat-abc");
        expect(f).toEqual({type: REKEY_HINT, to: "peer-123", conversationId: "chat-abc"});
        // Exactly these three fields — nothing that could redirect to an attacker device (no publicKey,
        // no deviceId, no prekey). Field-set check, not a substring scan (the type name contains "key").
        expect(Object.keys(f).sort()).toEqual(["conversationId", "to", "type"]);
    });

    it("throttle fires at most once per window per key, independently per key", () => {
        const t = makeThrottle(1000);
        expect(t("bob", 0)).toBe(true);      // first for bob
        expect(t("bob", 500)).toBe(false);   // within window
        expect(t("carol", 500)).toBe(true);  // different key, independent
        expect(t("bob", 1001)).toBe(true);   // window elapsed
    });
});
