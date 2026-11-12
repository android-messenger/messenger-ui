import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";
import {renderHook, act} from "@testing-library/react";

vi.mock("react-i18next", () => ({useTranslation: () => ({t: (k: string) => k})}));

import {useVoiceRecorder} from "../useVoiceRecorder";

const track = {stop: vi.fn(), kind: "audio"};
const stream = {getTracks: () => [track]} as unknown as MediaStream;
let getUserMedia: ReturnType<typeof vi.fn>;

class FakeMediaRecorder {
    state = "recording";
    ondataavailable: ((e: unknown) => void) | null = null;
    onstop: (() => void) | null = null;
    s: MediaStream;
    opts?: unknown;
    constructor(s: MediaStream, opts?: unknown) { this.s = s; this.opts = opts; }
    start() {}
    stop() { this.state = "inactive"; this.onstop?.(); }
    static isTypeSupported() { return true; }
}

beforeEach(() => {
    track.stop.mockClear();
    getUserMedia = vi.fn(() => Promise.resolve(stream));
    Object.defineProperty(navigator, "mediaDevices", {configurable: true, value: {getUserMedia}});
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
});
afterEach(() => vi.unstubAllGlobals());

describe("useVoiceRecorder", () => {
    it("guards a double-tap: two rapid start() calls acquire the mic only ONCE", async () => {
        const {result, unmount} = renderHook(() => useVoiceRecorder());
        await act(async () => {
            const p1 = result.current.start();
            const p2 = result.current.start(); // synchronous re-entry — must be blocked by startingRef
            const [r1, r2] = await Promise.all([p1, p2]);
            expect(r1).toBe(true);
            expect(r2).toBe(false);
        });
        expect(getUserMedia).toHaveBeenCalledTimes(1);
        unmount();
    });

    it("releases the mic track on stop", async () => {
        const {result} = renderHook(() => useVoiceRecorder());
        await act(async () => { await result.current.start(); });
        await act(async () => { await result.current.stop(); });
        expect(track.stop).toHaveBeenCalled();
    });
});
