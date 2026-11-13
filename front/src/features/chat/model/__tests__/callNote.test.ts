import {describe, it, expect} from "vitest";
import {callNoteKey, missedCallMeta} from "../callNote";
import {toOutboxMessage} from "../mapper";

describe("unanswered-call line", () => {
    it("the mark gives the line's key; an ordinary message gives none", () => {
        expect(callNoteKey(missedCallMeta(true))).toBe("chat.missedCall");
        expect(callNoteKey(missedCallMeta(false))).toBe("chat.missedVideoCall");
        expect(callNoteKey(undefined)).toBeNull();
        expect(callNoteKey({attachmentId: "a"})).toBeNull();
    });

    it("the mark travels in the frame's meta next to the order id", () => {
        const m = toOutboxMessage({conversationId: "c1", recipientId: "peer", text: "📞 Missed call", orderId: "o1", meta: missedCallMeta(true)});
        expect((m.payload as {meta?: Record<string, string>}).meta).toEqual({call: "missed", media: "audio", orderId: "o1"});
        const plain = toOutboxMessage({conversationId: "c1", recipientId: "peer", text: "hi"});
        expect((plain.payload as {meta?: unknown}).meta).toBeUndefined();
    });
});
