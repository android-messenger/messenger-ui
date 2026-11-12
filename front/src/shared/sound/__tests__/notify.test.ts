import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";
import {startRinging, stopRinging, unlockAudio} from "../notify";

// A minimal fake AudioContext (jsdom has none). Kept as one stable object because notify.ts caches the
// context module-level after the first use; tests mutate `.state` to drive unlockAudio / the WebAudio fallback.
const chain = {connect: () => chain};
const fakeCtx = {
    state: "running" as string,
    currentTime: 0,
    resume: vi.fn(() => Promise.resolve()),
    createOscillator: () => ({type: "", frequency: {setValueAtTime: () => {}}, connect: () => chain, start: () => {}, stop: () => {}}),
    createGain: () => ({gain: {setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {}}, connect: () => chain}),
    destination: {},
};

// A stable fake ringtone <audio> element (notify.ts caches the first one it builds).
const fakeRingEl = {
    loop: false, preload: "", muted: false, currentTime: 0,
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
};

beforeEach(() => {
    vi.stubGlobal("AudioContext", function () { return fakeCtx; });
    // new Audio(url) → our stable fake; a plain function so `new` returns the returned object.
    vi.stubGlobal("Audio", function () { return fakeRingEl; });
    vi.stubGlobal("URL", {createObjectURL: () => "blob:ring", revokeObjectURL: () => {}});
    fakeCtx.state = "running";
    fakeCtx.resume.mockClear();
    fakeRingEl.play.mockReset().mockResolvedValue(undefined);
    fakeRingEl.pause.mockClear();
    fakeRingEl.muted = false; fakeRingEl.currentTime = 0;
    stopRinging(); // reset module ring state between tests
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("notify — unlockAudio", () => {
    it("resumes a suspended AudioContext", () => {
        fakeCtx.state = "suspended";
        unlockAudio();
        expect(fakeCtx.resume).toHaveBeenCalledTimes(1);
    });
    it("resumes an iOS 'interrupted' AudioContext", () => {
        fakeCtx.state = "interrupted";
        unlockAudio();
        expect(fakeCtx.resume).toHaveBeenCalledTimes(1);
    });
    it("is a no-op (no resume) when the context is already running", () => {
        fakeCtx.state = "running";
        unlockAudio();
        expect(fakeCtx.resume).not.toHaveBeenCalled();
    });
});

describe("notify — ringtone", () => {
    it("startRinging plays the looping <audio> element; a second call is a no-op; stopRinging pauses it", () => {
        startRinging();
        startRinging(); // already ringing → must not start a second time
        expect(fakeRingEl.play).toHaveBeenCalledTimes(1);
        expect(fakeRingEl.loop).toBe(true);

        stopRinging();
        expect(fakeRingEl.pause).toHaveBeenCalledTimes(1);
    });

    it("a stop before a rejected play() settles does NOT resurrect the ring (race)", async () => {
        fakeRingEl.play.mockRejectedValueOnce(new Error("NotAllowedError"));
        const setSpy = vi.spyOn(globalThis, "setInterval");

        startRinging();      // element play() will reject...
        stopRinging();       // ...but we stop before it settles
        await flush();       // the late rejection must be ignored (superseded)

        expect(setSpy).not.toHaveBeenCalled();   // no WebAudio ring left running
    });

    it("falls back to the WebAudio interval loop when the element's play() is blocked", async () => {
        fakeRingEl.play.mockRejectedValueOnce(new Error("NotAllowedError"));
        const setSpy = vi.spyOn(globalThis, "setInterval");
        const clearSpy = vi.spyOn(globalThis, "clearInterval");

        startRinging();
        await flush();                       // let the rejected play() settle → fallback arms the interval
        expect(setSpy).toHaveBeenCalledTimes(1);

        stopRinging();
        expect(clearSpy).toHaveBeenCalledTimes(1);
    });
});
