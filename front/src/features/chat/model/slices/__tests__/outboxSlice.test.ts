import {describe, it, expect} from "vitest";
import reducer, {enqueueMessage, markSent, markFailed, retryMessage, mergeOutbox, clearOutbox} from "../outboxSlice";
import {clearUser} from "@/features/auth/slices/userSlice";
import type {WireMessage} from "@/features/chat/model/schema/wireMessage.schema";

const init = () => reducer(undefined, {type: "@@init"});

function enqueue(id: string) {
    const payload = {type: "CHAT_IN", conversationId: "c1", recipientId: "peer", messageId: id,
        payload: {kind: "text", body: "hi"}} as WireMessage;
    return enqueueMessage({id, idempotencyKey: id, payload});
}

describe("outboxSlice", () => {
    it("enqueues a message as pending", () => {
        const s = reducer(init(), enqueue("m1"));
        expect(s.messages).toHaveLength(1);
        expect(s.messages[0]).toMatchObject({id: "m1", status: "pending", attempts: 0});
    });

    it("markSent removes the message and bumps the persist version", () => {
        let s = reducer(init(), enqueue("m1"));
        const v = s.outboxVersion;
        s = reducer(s, markSent("m1"));
        expect(s.messages).toHaveLength(0);
        expect(s.outboxVersion).not.toBe(v);
    });

    it("markFailed then retry resets the message to pending", () => {
        let s = reducer(init(), enqueue("m1"));
        s = reducer(s, markFailed("m1"));
        expect(s.messages[0].status).toBe("failed");
        s = reducer(s, retryMessage("m1"));
        expect(s.messages[0]).toMatchObject({status: "pending", attempts: 0});
    });

    // Spec 003, FR-020: the end of a session (a 401 → clearUser) is not a sign-out.
    it("the end of a session leaves the queue as it is", () => {
        let s = reducer(init(), enqueue("m1"));
        s = reducer(s, mergeOutbox(null));
        const before = s;
        s = reducer(s, clearUser());
        expect(s).toBe(before);
    });

    it("clearOutbox (sign-out, another account) empties the queue; it is read from the disk again", () => {
        let s = reducer(init(), enqueue("m1"));
        s = reducer(s, enqueue("m2"));
        s = reducer(s, mergeOutbox(null));
        const v = s.outboxVersion;
        s = reducer(s, clearOutbox());
        expect(s.messages).toHaveLength(0);
        expect(s.restored).toBe(false);
        expect(s.outboxVersion).not.toBe(v);
    });

    it("mergeOutbox puts the stored messages first, keeps what was queued meanwhile, takes none twice", () => {
        let s = reducer(init(), enqueue("fresh"));
        expect(s.restored).toBe(false);
        const stored = reducer(reducer(init(), enqueue("old1")), enqueue("old2"));
        s = reducer(s, mergeOutbox(stored));
        expect(s.messages.map((m) => m.id)).toEqual(["old1", "old2", "fresh"]);
        expect(s.restored).toBe(true);
        const v = s.outboxVersion;
        s = reducer(s, mergeOutbox(stored));
        expect(s.messages.map((m) => m.id)).toEqual(["old1", "old2", "fresh"]);
        expect(s.outboxVersion).toBe(v);
    });

    it("mergeOutbox with nothing stored only marks the queue as read", () => {
        let s = reducer(init(), enqueue("fresh"));
        const v = s.outboxVersion;
        s = reducer(s, mergeOutbox(null));
        expect(s).toMatchObject({restored: true, outboxVersion: v});
        expect(s.messages.map((m) => m.id)).toEqual(["fresh"]);
    });
});
