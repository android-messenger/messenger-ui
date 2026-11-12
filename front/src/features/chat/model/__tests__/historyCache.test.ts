import {describe, it, expect} from "vitest";
import {sameMessage, hasMessage, upsertMessage} from "../historyCache";
import type {ChatMessage} from "../schema/domainChatMessage.schema";

const msg = (p: Partial<ChatMessage>): ChatMessage => ({
    id: "x", chatId: "c", from: "u", to: "v", text: "t",
    createdAt: new Date(0), status: "sent", ...p,
} as ChatMessage);

describe("historyCache.sameMessage", () => {
    it("matches by server id", () => {
        expect(sameMessage(msg({id: "s1"}), msg({id: "s1"}))).toBe(true);
    });
    it("matches an optimistic echo (id=clientId) to its server row (clientId=that id)", () => {
        const echo = msg({id: "cli-1", clientId: "cli-1"});
        const server = msg({id: "01ULID", clientId: "cli-1"});
        expect(sameMessage(echo, server)).toBe(true);
        expect(sameMessage(server, echo)).toBe(true);
    });
    it("matches two live deliveries sharing a clientId (lost-ACK resend)", () => {
        expect(sameMessage(msg({id: "a", clientId: "k"}), msg({id: "b", clientId: "k"}))).toBe(true);
    });
    it("does NOT merge two distinct messages", () => {
        expect(sameMessage(msg({id: "a", clientId: "ka"}), msg({id: "b", clientId: "kb"}))).toBe(false);
        expect(sameMessage(msg({id: "a"}), msg({id: "b"}))).toBe(false);
    });
});

describe("historyCache.upsertMessage / hasMessage", () => {
    it("appends a genuinely new message", () => {
        const draft = [msg({id: "a"})];
        upsertMessage(draft, msg({id: "b"}));
        expect(draft.map((m) => m.id)).toEqual(["a", "b"]);
    });
    it("is a no-op for an equivalent message (by id or clientId)", () => {
        const draft = [msg({id: "01ULID", clientId: "cli-1"})];
        upsertMessage(draft, msg({id: "cli-1", clientId: "cli-1"})); // the optimistic echo
        expect(draft).toHaveLength(1);
        expect(hasMessage(draft, msg({id: "cli-1", clientId: "cli-1"}))).toBe(true);
    });
});
