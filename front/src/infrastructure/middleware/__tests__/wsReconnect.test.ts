import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";

// The middleware is now feature-agnostic (deps injected), so no auth/api mocks are needed — the test
// supplies its own deps (a resolving session probe, a no-op clearUser action, no call ctx).
vi.mock("@/shared/config/ws", () => ({DELAY_STEP_MS: 500, MAX_RECONNECT_DELAY: 8000}));

// A controllable fake WebSocket: records every instance and lets the test drive open/close.
class FakeWS {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: FakeWS[] = [];
    readyState = FakeWS.CONNECTING;
    onopen: (() => void) | null = null;
    onclose: ((e: {code: number}) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    url: string;
    constructor(url: string) { this.url = url; FakeWS.instances.push(this); }
    close(code = 1000) { this.readyState = FakeWS.CLOSED; this.onclose?.({code}); }
    open() { this.readyState = FakeWS.OPEN; this.onopen?.(); }
    // simulate a server/network close of an already-open socket (default 1006 = abnormal)
    serverClose(code = 1006) { this.readyState = FakeWS.CLOSED; this.onclose?.({code}); }
}

function makeStore() {
    return {
        getState: () => ({user: {id: "me"}}),
        dispatch: vi.fn(),
    };
}

const CONNECT = {type: "ws/connect", payload: {url: "wss://x/ws"}, meta: {shouldReconnect: true}};

let mw: ReturnType<typeof import("../wsMiddleware").createWebsocketMiddleware>;

beforeEach(async () => {
    vi.useFakeTimers();
    // Pin the reconnect jitter to its midpoint (factor 0.8 + 0.5*0.4 = 1.0) so scheduleReconnect's
    // delay equals the raw backoff — otherwise the ±20% jitter would make these exact-advance
    // timing assertions flaky. (In production the jitter decorrelates a mass reconnect wave.)
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    FakeWS.instances = [];
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    // Fresh module state per test (socket/rapidCycles/cooldownUntil are module-level).
    vi.resetModules();
    const {createWebsocketMiddleware} = await import("../wsMiddleware");
    mw = createWebsocketMiddleware({
        probeSession: () => Promise.resolve(),
        clearUser: () => ({type: "user/clearUser"}),
        callConversationId: () => undefined,
    });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function dispatchConnect() {
    const store = makeStore();
    const run = mw(store as never)((a: unknown) => a);
    run(CONNECT as never);
    return store;
}

describe("wsMiddleware reconnect circuit breaker", () => {
    it("reconnects normally after a durable connection closes (no cooldown)", () => {
        dispatchConnect();
        expect(FakeWS.instances).toHaveLength(1);
        FakeWS.instances[0].open();
        // Stay up well past the rapid window, then the server closes it.
        vi.advanceTimersByTime(20_000);
        FakeWS.instances[0].serverClose();
        // A normal (small-backoff) reconnect fires well under the cooldown.
        vi.advanceTimersByTime(2_000);
        expect(FakeWS.instances.length).toBe(2); // reconnected promptly
    });

    it("does NOT auto-reconnect after a 4409 take-over close, and flags the session superseded", () => {
        const store = dispatchConnect();
        FakeWS.instances[0].open();
        vi.advanceTimersByTime(1_000);
        FakeWS.instances[0].serverClose(4409); // backend evicted this (older) session
        vi.advanceTimersByTime(30_000);
        expect(FakeWS.instances.length).toBe(1); // stayed put — no reconnect loop
        // The banner reads this flag to explain the take-over and offer "reconnect here".
        expect(store.dispatch).toHaveBeenCalledWith(expect.objectContaining({type: "ws/superseded"}));
    });

    it("a plain abnormal close (1006 network drop) still auto-reconnects", () => {
        dispatchConnect();
        FakeWS.instances[0].open();
        vi.advanceTimersByTime(20_000);
        FakeWS.instances[0].serverClose(1006);
        vi.advanceTimersByTime(2_000);
        expect(FakeWS.instances.length).toBe(2); // reconnected
    });

    it("NEVER blocks: a wake (ws/connect) reconnects immediately even during a cooldown", () => {
        const store = dispatchConnect();
        // Arm the cooldown with 3 rapid cycles.
        for (let i = 0; i < 3; i++) {
            const ws = FakeWS.instances[FakeWS.instances.length - 1];
            ws.open();
            vi.advanceTimersByTime(200);
            ws.serverClose();
            vi.advanceTimersByTime(1_000);
        }
        const armed = FakeWS.instances.length;
        // A user-driven ws/connect (visibility/online wake) must open a socket RIGHT NOW — the
        // regression was connect() deferring forever behind a stale reconnect timer.
        const run = mw(store as never)((a: unknown) => a);
        run(CONNECT as never);
        expect(FakeWS.instances.length).toBe(armed + 1);
    });

    it("throttles to a cooldown after 3 rapid open→close cycles (eviction ping-pong)", () => {
        dispatchConnect();
        // 3 rapid cycles: open then close almost immediately, each time.
        for (let i = 0; i < 3; i++) {
            const ws = FakeWS.instances[FakeWS.instances.length - 1];
            ws.open();
            vi.advanceTimersByTime(200);      // alive < RAPID_CLOSE_MS
            ws.serverClose();
            vi.advanceTimersByTime(1_000);    // let the (small-backoff) reconnect fire → next instance
        }
        const afterThree = FakeWS.instances.length;
        // The breaker is now armed. A short advance must NOT spawn a new socket...
        vi.advanceTimersByTime(5_000);
        expect(FakeWS.instances.length).toBe(afterThree);
        // ...but after the ~60s cooldown, exactly one retry is attempted.
        vi.advanceTimersByTime(60_000);
        expect(FakeWS.instances.length).toBe(afterThree + 1);
    });

    it("a durable reconnect after some rapid cycles clears the breaker", () => {
        dispatchConnect();
        // 2 rapid cycles (below the limit)...
        for (let i = 0; i < 2; i++) {
            const ws = FakeWS.instances[FakeWS.instances.length - 1];
            ws.open();
            vi.advanceTimersByTime(200);
            ws.serverClose();
            vi.advanceTimersByTime(1_000);
        }
        // ...then a durable connection resets rapidCycles.
        const ws = FakeWS.instances[FakeWS.instances.length - 1];
        ws.open();
        vi.advanceTimersByTime(15_000); // > RAPID_CLOSE_MS → stableTimer clears the counter
        ws.serverClose();
        const before = FakeWS.instances.length;
        vi.advanceTimersByTime(2_000);
        expect(FakeWS.instances.length).toBe(before + 1); // prompt reconnect, no cooldown
    });
});
