import {afterAll, vi} from "vitest";

// Runs in every test file, before the file's own imports.
//
// A Redux store tells its subscribers on the next animation frame. A frame asked for by the last test of
// a file — or by work that test left running — would fire after the page (jsdom) is closed, and the whole
// run then fails with an error that belongs to no test ("Cannot read properties of null (reading
// '_location')", "cancelAnimationFrame is not defined"). So:
//  - at its end every file waits until all the frames it asked for have run;
//  - a frame asked for after that runs at once, and what it throws without a page is dropped.

let closed = false;
let waiting = 0;
const frame = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame.bind(window)
    : null;

if (frame) {
    window.requestAnimationFrame = (callback) => {
        if (!closed) {
            waiting++;
            return frame((at) => { waiting--; callback(at); });
        }
        queueMicrotask(() => { try { callback(performance.now()); } catch { /* the page is gone */ } });
        return 0;
    };
}

afterAll(async () => {
    vi.useRealTimers();
    if (frame) {
        // two frames in a row with nothing waiting; a second at most (a cancelled frame is never counted off)
        for (let quiet = 0, i = 0; quiet < 2 && i < 60; i++) {
            // the timer: a page whose frames have stopped must not hang the file
            await new Promise<void>((done) => { frame(() => done()); setTimeout(done, 100); });
            quiet = waiting === 0 ? quiet + 1 : 0;
        }
    }
    closed = true;
});
