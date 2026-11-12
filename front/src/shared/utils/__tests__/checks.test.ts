import {describe, it, expect} from "vitest";
import {isNotLogged, anonimo} from "../checks";

describe("isNotLogged", () => {
    it("is true for empty / whitespace / non-string / the anonimo sentinel", () => {
        expect(isNotLogged(null)).toBe(true);
        expect(isNotLogged(undefined)).toBe(true);
        expect(isNotLogged("")).toBe(true);
        expect(isNotLogged("   ")).toBe(true);
        expect(isNotLogged({trait: "x"})).toBe(true); // non-string degrades to not-logged
        expect(isNotLogged(anonimo)).toBe(true);
    });

    it("is false for a real user id", () => {
        expect(isNotLogged("user-123")).toBe(false);
    });
});
