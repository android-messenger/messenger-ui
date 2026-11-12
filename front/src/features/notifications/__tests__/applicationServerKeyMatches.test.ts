import {describe, it, expect} from "vitest";
import {applicationServerKeyMatches} from "../push";

const buf = (bytes: number[]) => new Uint8Array(bytes).buffer;

describe("applicationServerKeyMatches", () => {
    it("true when the subscription key equals the current VAPID key (byte-for-byte)", () => {
        expect(applicationServerKeyMatches(buf([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    });

    it("false when bytes differ (stale/rotated key → must re-subscribe, fixes Apple BadJwtToken)", () => {
        expect(applicationServerKeyMatches(buf([1, 2, 3]), new Uint8Array([1, 2, 9]))).toBe(false);
    });

    it("false when lengths differ", () => {
        expect(applicationServerKeyMatches(buf([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    });

    it("false when the existing subscription has no key", () => {
        expect(applicationServerKeyMatches(null, new Uint8Array([1]))).toBe(false);
        expect(applicationServerKeyMatches(undefined, new Uint8Array([1]))).toBe(false);
    });
});
