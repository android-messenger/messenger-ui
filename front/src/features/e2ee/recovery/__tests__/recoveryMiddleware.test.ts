import {describe, it, expect, vi, beforeEach} from "vitest";

// The RECOVER_RESP handler: recovered items patch in, NACKed ids are marked lost — but ONLY from the peer we
// actually asked, for that chat, and never clobbering a message the same response just recovered. clientIds
// ride the frames in the clear, so an unauthenticated NACK from a third party must NOT force a false "lost".
const h = vi.hoisted(() => ({
    inApp: true,
    applyResponse: vi.fn(),
    savePlaintext: vi.fn(async () => {}),
    allPending: vi.fn(),
    removePending: vi.fn(async () => {}),
}));

vi.mock("../protocol.ts", async (orig) => ({
    ...(await orig<typeof import("../protocol.ts")>()),
    applyResponse: h.applyResponse, buildResponse: vi.fn(),
}));
vi.mock("../../lib/atRest.ts", () => ({savePlaintext: h.savePlaintext}));
vi.mock("../../crypto.ts", () => ({secretCrypto: {resetSession: vi.fn(async () => {})}, secretAvailable: () => h.inApp}));
vi.mock("../pendingStore.ts", () => ({
    allPending: h.allPending, removePending: h.removePending,
    addPending: vi.fn(async () => []), bumpAttempt: vi.fn(async () => {}),
}));
vi.mock("@/features/chat/rest/chatApi.ts", () => ({
    chatApi: {util: {updateQueryData: vi.fn((endpoint, args, recipe) => ({type: "uqd", endpoint, args, recipe}))}},
}));
vi.mock("@/shared/i18n", () => ({default: {t: (k: string) => k}}));

import {e2eeRecoveryMiddleware} from "../e2eeRecoveryMiddleware.ts";
import {RECOVER_RESP} from "../protocol.ts";
import {presenceJoin} from "@/features/presence/model/presenceSlice.ts";

type Dispatched = {type: string; [k: string]: unknown};
// Fresh timestamps: within the 48h recovery window and recently requested, so the reconnect-triggered
// retry tick is a no-op and each test isolates the RECOVER_RESP handler.
const pend = (over: Record<string, unknown> = {}) => ({
    clientId: "c1", serverId: "s1", chatId: "chat", peerId: "bob", attempts: 1, lastAt: Date.now(), createdAt: Date.now(), ...over,
});

function harness() {
    const dispatched: Dispatched[] = [];
    const store = {
        dispatch: vi.fn((a: Dispatched) => { dispatched.push(a); return a; }),
        getState: vi.fn(() => ({user: {id: "me"}, ws: {status: "connected"}})),
    };
    const run = (frame: unknown) =>
        e2eeRecoveryMiddleware(store as never)(((a: unknown) => a) as never)({type: "ws/incoming", payload: frame});
    return {dispatched, run};
}
const flush = () => new Promise((r) => setTimeout(r, 0));
// Final text a given serverId settled on, after applying every getChatHistory patch recipe in order.
const textFor = (d: Dispatched[], serverId: string) => {
    const draft = [{id: serverId, text: "?", secret: false}];
    for (const a of d) if (a.type === "uqd" && a.endpoint === "getChatHistory") (a.recipe as (x: unknown[]) => void)(draft);
    return draft[0].text;
};
const resp = (over: Record<string, unknown> = {}) =>
    ({type: RECOVER_RESP, from: "bob", conversationId: "chat", items: [], missing: [], ...over});

beforeEach(() => {
    h.applyResponse.mockReset().mockResolvedValue([]);
    h.savePlaintext.mockClear();
    h.removePending.mockReset().mockResolvedValue(undefined);
    h.allPending.mockReset().mockResolvedValue([pend()]);
});

describe("recovery middleware — a browser has no keys", () => {
    it("neither asks for recovery nor handles a recovery frame", async () => {
        h.inApp = false;
        try {
            h.allPending.mockResolvedValue([pend({lastAt: 0})]);
            const {dispatched, run} = harness();
            run({type: RECOVER_RESP, from: "bob", conversationId: "chat", items: [], missing: ["c1"]});
            await flush(); await flush();
            expect(dispatched).toEqual([]);
            expect(h.applyResponse).not.toHaveBeenCalled();
            expect(h.removePending).not.toHaveBeenCalled();
        } finally { h.inApp = true; }
    });
});

describe("recovery middleware — RECOVER_RESP handling", () => {
    it("marks a NACKed id lost when it comes from the asked peer + chat", async () => {
        const {dispatched, run} = harness();
        run(resp({missing: ["c1"]}));
        await flush();
        expect(textFor(dispatched, "s1")).toBe("chat.decryptLost");
        expect(h.removePending).toHaveBeenCalledWith("c1");
    });

    it("IGNORES a forged NACK from a different peer (no false lost, no removal)", async () => {
        const {dispatched, run} = harness();
        run(resp({from: "mallory", missing: ["c1"]}));
        await flush();
        expect(textFor(dispatched, "s1")).toBe("?");            // untouched
        expect(h.removePending).not.toHaveBeenCalled();
    });

    it("IGNORES a NACK whose conversation doesn't match the pending item", async () => {
        const {dispatched, run} = harness();
        run(resp({conversationId: "other", missing: ["c1"]}));
        await flush();
        expect(textFor(dispatched, "s1")).toBe("?");
        expect(h.removePending).not.toHaveBeenCalled();
    });

    it("recovered wins over a colliding missing entry (same id in both lists)", async () => {
        h.applyResponse.mockResolvedValue([{forClientId: "c1", plaintext: "hola"}]);
        const {dispatched, run} = harness();
        run(resp({items: [{mid: "c1", t: 3, b: "x"}], missing: ["c1"]}));
        await flush();
        expect(textFor(dispatched, "s1")).toBe("hola");         // NOT overwritten with "lost"
        expect(h.savePlaintext).toHaveBeenCalledWith("s1", "chat", "hola");
        expect(h.removePending).toHaveBeenCalledTimes(1);       // removed once, by the recovered path
    });
    it("a recovered row carries secret === true (keeps the plaintext out of the disk cache)", async () => {
        h.applyResponse.mockResolvedValue([{forClientId: "c1", plaintext: "hola"}]);
        const {dispatched, run} = harness();
        run(resp({items: [{mid: "c1", t: 3, b: "x"}]}));
        await flush();
        const draft = [{id: "s1", text: "?", secret: false}];
        for (const a of dispatched) if (a.type === "uqd" && a.endpoint === "getChatHistory") (a.recipe as (x: unknown[]) => void)(draft);
        expect(draft[0]).toMatchObject({text: "hola", secret: true});
    });
});

// Re-requests: the request is a transient SIGNAL the backend drops while the sender is absent, so it goes
// out again at once when we reconnect or the sender comes online, and otherwise at least once a minute.
describe("recovery middleware — when re-requests go out", () => {
    const sends = (d: Dispatched[]) => d.filter((a) => a.type === "ws/send");
    const join = (id: string) => ({type: presenceJoin.type, payload: {id}});

    function connectedHarness() {
        const dispatched: Dispatched[] = [];
        let status = "disconnected";
        const store = {
            dispatch: vi.fn((a: Dispatched) => { dispatched.push(a); return a; }),
            getState: vi.fn(() => ({user: {id: "me"}, ws: {status}})),
        };
        const mw = e2eeRecoveryMiddleware(store as never)(((a: unknown) => a) as never);
        const act = (a: unknown) => mw(a as never);
        act({type: "noop"});                      // not connected yet: nothing
        status = "connected";
        return {dispatched, act};
    }

    it("our reconnect re-requests even an item asked a moment ago", async () => {
        const {dispatched, act} = connectedHarness();
        act({type: "ws/connected"});
        await flush();
        expect(sends(dispatched)).toHaveLength(1);
    });

    it("a sender coming online is asked at once, other peers are not", async () => {
        h.allPending.mockResolvedValue([pend(), pend({clientId: "c2", serverId: "s2", peerId: "carol"})]);
        const {dispatched, act} = connectedHarness();
        act({type: "ws/connected"});
        await flush();
        dispatched.length = 0;
        act(join("bob"));
        await flush();
        const s = sends(dispatched);
        expect(s).toHaveLength(1);
        expect(JSON.stringify(s[0])).toContain("bob");
        expect(JSON.stringify(s[0])).not.toContain("carol");
    });

    it("a flapping sender is asked at most once per 10 s", async () => {
        const {dispatched, act} = connectedHarness();
        act({type: "ws/connected"});
        await flush();
        dispatched.length = 0;
        act(join("bob"));
        await flush();
        act(join("bob"));
        await flush();
        expect(sends(dispatched)).toHaveLength(1);
    });

    it("without events, a long-pending item is re-requested after a minute, not five", async () => {
        const old = Date.now() - 61_000;
        h.allPending.mockResolvedValue([pend({attempts: 10, lastAt: old, createdAt: old})]);
        vi.useFakeTimers({toFake: ["setInterval"]});
        try {
            const {dispatched, act} = connectedHarness();
            act({type: "noop"});                  // the connect tick is forced anyway; reset and wait a tick
            await flush();
            dispatched.length = 0;
            vi.advanceTimersByTime(15_000);
            await flush();
            expect(sends(dispatched)).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
