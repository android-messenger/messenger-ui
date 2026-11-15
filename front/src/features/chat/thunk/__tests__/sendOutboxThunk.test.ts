import {describe, it, expect, vi} from "vitest";
import {flushOutbox} from "../sendOutboxThunk";
import {OUTBOX_RETRY_MAX_ATTEMPTS, OUTBOX_SEND_TIMEOUT_MS} from "@/shared/config/outbox";

// One frame per connection: a message with no confirmation is not sent again over the connection it went
// over; it goes out once on every new connection, and is marked failed when a living connection is silent
// for OUTBOX_SEND_TIMEOUT_MS or after MAX_ATTEMPTS connections (spec 003, FR-030, FR-031).
type Msg = {
    id: string; idempotencyKey: string; payload: unknown; status: string;
    attempts: number; sentEpoch?: number; lastAttemptAt?: number;
};

function run(state: { ws: { status: string; epoch: number }; outbox: { messages: Msg[] } }) {
    const dispatch = vi.fn((a) => a);
    const getState = () => state;
    // Invoke the thunk directly with a mocked store API.
    return flushOutbox()(dispatch as never, getState as never, undefined).then(() => dispatch);
}

const sends = (d: ReturnType<typeof vi.fn>) =>
    d.mock.calls.map((c) => c[0]).filter((a) => a?.type === "ws/send");
const marksSending = (d: ReturnType<typeof vi.fn>) =>
    d.mock.calls.map((c) => c[0]).filter((a) => a?.type === "outbox/markSending");
const marksFailed = (d: ReturnType<typeof vi.fn>) =>
    d.mock.calls.map((c) => c[0]).filter((a) => a?.type === "outbox/markFailed");

const msg = (over: Partial<Msg> = {}): Msg => ({
    id: "m1", idempotencyKey: "m1", payload: {type: "CHAT_IN"}, status: "pending", attempts: 0, ...over,
});

const ago = (ms: number) => Date.now() - ms;

describe("flushOutbox (one frame per connection)", () => {
    it("does nothing when disconnected", async () => {
        const d = await run({ws: {status: "disconnected", epoch: 3}, outbox: {messages: [msg()]}});
        expect(sends(d)).toHaveLength(0);
        expect(marksSending(d)).toHaveLength(0);
    });

    it("sends a pending message and stamps the current epoch", async () => {
        const d = await run({ws: {status: "connected", epoch: 5}, outbox: {messages: [msg()]}});
        expect(sends(d)).toHaveLength(1);
        expect(marksSending(d)[0].payload).toMatchObject({id: "m1", epoch: 5});
    });

    it("does not resend over the same connection, however long ago it was sent (below the limit)", async () => {
        const d = await run({
            ws: {status: "connected", epoch: 5},
            outbox: {messages: [msg({status: "sending", attempts: 1, sentEpoch: 5, lastAttemptAt: ago(OUTBOX_SEND_TIMEOUT_MS - 1_000)})]},
        });
        expect(sends(d)).toHaveLength(0);
        expect(marksSending(d)).toHaveLength(0);
        expect(marksFailed(d)).toHaveLength(0);
    });

    it("marks it failed, without sending, once the same connection is silent past the limit", async () => {
        const d = await run({
            ws: {status: "connected", epoch: 5},
            outbox: {messages: [msg({status: "sending", attempts: 1, sentEpoch: 5, lastAttemptAt: ago(OUTBOX_SEND_TIMEOUT_MS)})]},
        });
        expect(sends(d)).toHaveLength(0);
        expect(marksFailed(d)[0].payload).toBe("m1");
    });

    it("resends after a reconnect (newer epoch), at once", async () => {
        const d = await run({
            ws: {status: "connected", epoch: 6},
            outbox: {messages: [msg({status: "sending", attempts: 1, sentEpoch: 5, lastAttemptAt: ago(100)})]},
        });
        expect(sends(d)).toHaveLength(1);
        expect(marksSending(d)[0].payload).toMatchObject({id: "m1", epoch: 6});
    });

    it("gives up (markFailed) once attempts hit the cap, without sending", async () => {
        const d = await run({
            ws: {status: "connected", epoch: 9},
            outbox: {messages: [msg({status: "sending", attempts: OUTBOX_RETRY_MAX_ATTEMPTS, sentEpoch: 1, lastAttemptAt: ago(1_000)})]},
        });
        expect(sends(d)).toHaveLength(0);
        expect(marksFailed(d)[0].payload).toBe("m1");
    });

    it("skips sent/failed messages", async () => {
        const d = await run({
            ws: {status: "connected", epoch: 2},
            outbox: {messages: [msg({status: "sent"}), msg({id: "m2", status: "failed"})]},
        });
        expect(sends(d)).toHaveLength(0);
    });
});
