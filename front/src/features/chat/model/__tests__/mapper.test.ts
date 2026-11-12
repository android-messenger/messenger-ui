import {describe, it, expect, vi} from "vitest";
import {wireToChatMessage, toOutboxMessage, toChatMessageView} from "../mapper";
import type {WireMessage} from "../schema/wireMessage.schema.ts";
import type {ChatMessage} from "../schema/domainChatMessage.schema.ts";

vi.mock("@reduxjs/toolkit", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@reduxjs/toolkit")>()),
    nanoid: () => "nano-1",
}));

describe("wireToChatMessage", () => {
    it("sets clientId = correlationId (the dedup key) and maps the core fields", () => {
        const wire: WireMessage = {
            type: "CHAT_OUT", messageId: "srv-1", correlationId: "cli-1",
            conversationId: "c1", senderId: "u1", recipientId: "u2",
            serverTimestamp: 5000, senderTimestamp: 1000,
            payload: {kind: "attachment", body: "hi"}, meta: {attachmentId: "a1"},
        };
        const m = wireToChatMessage(wire);
        expect(m.id).toBe("srv-1");
        expect(m.clientId).toBe("cli-1");
        expect(m.chatId).toBe("c1");
        expect(m.from).toBe("u1");
        expect(m.to).toBe("u2");
        expect(m.text).toBe("hi");
        expect(m.kind).toBe("attachment");
        expect(m.meta).toEqual({attachmentId: "a1"});
        expect(m.status).toBe("sent");
        expect(m.createdAt.getTime()).toBe(5000); // serverTimestamp wins
    });

    it("falls back: senderTimestamp when no serverTimestamp; ''/nanoid for missing ids; '' text", () => {
        const m = wireToChatMessage({type: "CHAT_OUT", senderTimestamp: 1000} as WireMessage);
        expect(m.createdAt.getTime()).toBe(1000);
        expect(m.id).toBe("nano-1");     // no messageId, no id → nanoid
        expect(m.chatId).toBe("");
        expect(m.from).toBe("");
        expect(m.to).toBe("");
        expect(m.text).toBe("");
        expect(m.clientId).toBeUndefined();
    });

    it("uses String(id) when messageId is absent but a numeric outbox id is present", () => {
        const m = wireToChatMessage({type: "CHAT_ACK", id: 42, senderTimestamp: 1} as WireMessage);
        expect(m.id).toBe("42");
    });
});

describe("toOutboxMessage", () => {
    it("id === idempotencyKey, pending/0 attempts, threads orderId into meta", () => {
        const o = toOutboxMessage({conversationId: "c1", recipientId: "u2", text: "hey", orderId: "o9"});
        expect(o.id).toBe("nano-1");
        expect(o.idempotencyKey).toBe("nano-1");
        expect(o.status).toBe("pending");
        expect(o.attempts).toBe(0);
        expect(o.payload.meta).toEqual({orderId: "o9"});
    });

    it("meta is undefined when there's no orderId", () => {
        const o = toOutboxMessage({conversationId: "c1", recipientId: "u2", text: "hey"});
        expect(o.payload.meta).toBeUndefined();
    });
});

describe("toChatMessageView", () => {
    it("fromMe reflects sender === myId; createdAt is epoch ms", () => {
        const base: ChatMessage = {
            id: "1", chatId: "c1", from: "me", to: "u2", text: "x",
            createdAt: new Date(1234), status: "sent",
        };
        expect(toChatMessageView(base, "me").fromMe).toBe(true);
        expect(toChatMessageView(base, "other").fromMe).toBe(false);
        expect(toChatMessageView(base, "me").createdAt).toBe(1234);
    });
});
