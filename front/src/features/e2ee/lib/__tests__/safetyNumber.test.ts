import {describe, it, expect} from "vitest";
import {formatSafetyNumber} from "../safetyNumber";

describe("safety number formatting", () => {
    it("groups the digits into readable 5-char chunks", () => {
        expect(formatSafetyNumber("1234567890123")).toBe("12345 67890 123");
    });
});
