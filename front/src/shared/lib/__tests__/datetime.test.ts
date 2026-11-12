import {describe, it, expect} from "vitest";
import {sameDay, formatLocalTime, formatLocalDate} from "../datetime";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min, 0).getTime();

describe("shared/lib/datetime", () => {
    it("sameDay: same local calendar day (ignores time), different days are false", () => {
        expect(sameDay(at(2026, 6, 22, 1), at(2026, 6, 22, 23))).toBe(true);
        expect(sameDay(at(2026, 6, 22), at(2026, 6, 21))).toBe(false);
        expect(sameDay(at(2026, 6, 22), at(2025, 6, 22))).toBe(false);
    });

    it("formatLocalTime: HH:mm matches the runner's local conversion (not UTC)", () => {
        const ms = at(2026, 6, 22, 9, 30);
        expect(formatLocalTime(ms)).toBe(new Date(ms).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}));
    });

    it("formatLocalDate: omits the year in the current year, includes it otherwise", () => {
        const now = at(2026, 6, 22);
        expect(formatLocalDate(at(2026, 6, 10), now)).not.toContain("2026");
        expect(formatLocalDate(at(2024, 0, 3), now)).toContain("2024");
    });
});
