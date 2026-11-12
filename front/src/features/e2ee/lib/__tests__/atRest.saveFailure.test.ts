// @vitest-environment node
import "fake-indexeddb/auto";
import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";

// Spec 001, story 5, finding 46: a failed save of decrypted text was swallowed (`catch {}`), and the only
// copy the client can show after a reload was lost without a trace.

const h = vi.hoisted(() => ({wrapBytes: vi.fn(), warn: vi.fn()}));
vi.mock("../deviceKey", async (orig) => ({...(await orig<typeof import("../deviceKey")>()), wrapBytes: h.wrapBytes}));
vi.mock("@/shared/logger/logger.ts", () => ({logger: {warn: h.warn, debug: vi.fn(), error: vi.fn(), info: vi.fn()}}));

import {savePlaintext, SAVE_ATTEMPTS} from "../atRest";

const wrapped = {iv: new Uint8Array(12).buffer, ct: new Uint8Array(4).buffer};
const TEXT = "meet at the old bridge at nine";

describe("savePlaintext: a failure is retried and reported", () => {
    beforeEach(() => { h.wrapBytes.mockReset(); h.warn.mockReset(); });
    afterEach(() => { vi.useRealTimers(); });

    it("returns true when the text is stored", async () => {
        h.wrapBytes.mockResolvedValue(wrapped);
        expect(await savePlaintext("m-ok", "c1", TEXT)).toBe(true);
        expect(h.wrapBytes).toHaveBeenCalledTimes(1);
    });

    it("tries again after a failure and succeeds", async () => {
        h.wrapBytes.mockRejectedValueOnce(new Error("quota")).mockResolvedValue(wrapped);
        expect(await savePlaintext("m-retry", "c1", TEXT)).toBe(true);
        expect(h.wrapBytes).toHaveBeenCalledTimes(2);
        expect(h.warn).not.toHaveBeenCalled();
    });

    it("returns false after every attempt failed, and says so in the log without the text", async () => {
        h.wrapBytes.mockRejectedValue(new Error("storage is gone"));
        expect(await savePlaintext("m-fail", "c1", TEXT)).toBe(false);
        expect(h.wrapBytes).toHaveBeenCalledTimes(SAVE_ATTEMPTS);
        expect(h.warn).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(h.warn.mock.calls)).not.toContain(TEXT);
    });
});
