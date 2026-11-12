import { describe, it, expect } from "vitest";
import { isUlid, ulidTimeMs } from "@/shared/ulid/ulid.ts";

describe("ulid", () => {
    it("recognises well-formed ULIDs and rejects nanoid client ids", () => {
        expect(isUlid("01KXXNQE8FJW5RYRQNZ7QGCMG6")).toBe(true);
        expect(isUlid("V1StGXR8_Z5jdHi6B-myT")).toBe(false); // nanoid (has _,-, lowercase)
        expect(isUlid("id-thsuqs9axci")).toBe(false);
        expect(isUlid("")).toBe(false);
        expect(isUlid(undefined)).toBe(false);
        expect(isUlid("01KXXNQE8FJW5RYRQNZ7QGCMG")).toBe(false); // 25 chars
    });

    it("decodes the 48-bit timestamp from the first 10 chars", () => {
        // A ULID minted at epoch 0 has an all-zero timestamp prefix.
        expect(ulidTimeMs("0000000000XXXXXXXXXXXXXXXX")).toBe(0);
        // Known vector: timestamp 1469918176385 ms → "01ARYZ6S41" prefix (ULID spec example).
        expect(ulidTimeMs("01ARYZ6S41TSV4RRFFQ69G5FAV")).toBe(1469918176385);
    });

    it("returns NaN for non-ULID ids so `createdAt <= NaN` is false (not a bogus match)", () => {
        expect(Number.isNaN(ulidTimeMs("id-thsuqs9axci"))).toBe(true);
        expect(Number.isNaN(ulidTimeMs(undefined))).toBe(true);
        expect(Date.now() <= ulidTimeMs("id-abc")).toBe(false);
    });

    it("orders chronologically the same as lexicographically", () => {
        const older = "01ARYZ6S41TSV4RRFFQ69G5FAV";
        const newer = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
        expect(older < newer).toBe(true);
        expect(ulidTimeMs(older)).toBeLessThan(ulidTimeMs(newer));
    });
});
