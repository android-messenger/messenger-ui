import {describe, it, expect} from "vitest";

// Spec 001, story 5, finding 51: two sources carried a raw NUL byte as a separator inside a comparison
// key. An editor or a tool that drops it changes the key silently, and `grep` skips such files as binary.
// The separator is now written as an escape sequence; no source may contain the raw byte.

const sources = import.meta.glob("/src/**/*.{ts,tsx,css}", {query: "?raw", import: "default", eager: true}) as Record<string, string>;
const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(92) + "0";   // backslash, zero — as written in the source
const count = (file: string, needle: string) => sources[file].split(needle).length - 1;

describe("sources", () => {
    it("are found", () => {
        expect(Object.keys(sources).length).toBeGreaterThan(100);
    });

    it("contain no raw NUL byte", () => {
        expect(Object.keys(sources).filter((p) => sources[p].includes(NUL))).toEqual([]);
    });

    it("the comparison keys still separate their parts, now with the escape sequence", () => {
        expect(count("/src/features/chat/rest/chatApi.ts", ESC)).toBe(2);
        expect(count("/src/features/chat/model/services/chatMessages.service.ts", ESC)).toBe(1);
    });
});
