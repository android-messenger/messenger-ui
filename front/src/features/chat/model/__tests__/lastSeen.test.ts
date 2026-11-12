import {describe, it, expect} from "vitest";
import {fmtLastSeen} from "../lastSeen";

const t = (k: string) => (k === "chat.yesterday" ? "Yesterday" : k);
// A fixed "now": 2026-07-22 12:00 local. Tests build lastSeen relative to it so they're TZ-agnostic.
const NOW = new Date(2026, 6, 22, 12, 0, 0).getTime();
const localHHMM = (ms: number) => new Date(ms).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});

describe("fmtLastSeen", () => {
    it("returns null for a null/undefined timestamp (peer online / unknown)", () => {
        expect(fmtLastSeen(null, t, NOW)).toBeNull();
        expect(fmtLastSeen(undefined, t, NOW)).toBeNull();
    });

    it("shows only the local time when last seen today", () => {
        const ms = new Date(2026, 6, 22, 9, 30, 0).getTime();
        expect(fmtLastSeen(ms, t, NOW)).toBe(localHHMM(ms));
    });

    it("prefixes 'yesterday' when last seen the previous day", () => {
        const ms = new Date(2026, 6, 21, 22, 15, 0).getTime();
        expect(fmtLastSeen(ms, t, NOW)).toBe(`Yesterday ${localHHMM(ms)}`);
    });

    it("shows a date + time for older days (same year: no year)", () => {
        const ms = new Date(2026, 6, 10, 8, 5, 0).getTime();
        const out = fmtLastSeen(ms, t, NOW)!;
        expect(out).toContain(localHHMM(ms));
        expect(out).not.toContain("2026");      // same year → year omitted
        expect(out.startsWith("Yesterday")).toBe(false);
    });

    it("includes the year for a different year", () => {
        const ms = new Date(2024, 0, 3, 14, 0, 0).getTime();
        const out = fmtLastSeen(ms, t, NOW)!;
        expect(out).toContain("2024");
        expect(out).toContain(localHHMM(ms));
    });

    it("renders in the viewer's LOCAL time (converts from the UTC epoch input)", () => {
        // 2026-07-22T00:00:00Z — assert the output carries the LOCAL HH:mm for that instant (not a
        // blind UTC "00:00"). Which day-label wraps it depends on the runner's TZ, so only assert the
        // local time is present.
        const utcMidnight = Date.UTC(2026, 6, 22, 0, 0, 0);
        const out = fmtLastSeen(utcMidnight, t, NOW)!;
        expect(out).toContain(localHHMM(utcMidnight));
    });
});
