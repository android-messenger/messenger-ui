import {describe, it, expect} from "vitest";
import reducer, {enqueueMessage, markSent, markFailed, retryMessage} from "../outboxSlice";
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

    it("clears the queue on logout so it can't be re-flushed under the next user", () => {
        let s = reducer(init(), enqueue("m1"));
        s = reducer(s, enqueue("m2"));
        const v = s.outboxVersion;
        s = reducer(s, clearUser());
        expect(s.messages).toHaveLength(0);
        // version bumped so the debounced persister overwrites the on-disk copy with the empty queue
        expect(s.outboxVersion).not.toBe(v);
    });
});
