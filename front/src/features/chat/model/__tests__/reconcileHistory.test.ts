import {describe, it, expect} from "vitest";
import {toMessages, dedupMessages} from "../reconcileHistory";
import type {ChatMessage} from "../schema/domainChatMessage.schema";

// A minimal wire row the parser accepts (mirrors CHAT_OUT / history rows).
const row = (over: Record<string, unknown> = {}) => ({
    type: "CHAT_OUT",
    messageId: "01KY29D4BHHB40EW2FKMHR6V7M",
    conversationId: "c1",
    senderId: "peer",
    recipientId: "me",
    serverTimestamp: 1_700_000_000_000,
    payload: {body: "hi", kind: "text"},
    ...over,
});

describe("reconcileHistory.toMessages", () => {
    it("accepts the { messages: [...] } envelope", () => {
        const out = toMessages({messages: [row(), row({messageId: "01KY29D4BHHB40EW2FKMHR6V7N"})]});
        expect(out).toHaveLength(2);
        expect(out[0].id).toBe("01KY29D4BHHB40EW2FKMHR6V7M");
        expect(out[0].text).toBe("hi");
    });

    it("accepts a bare array (legacy)", () => {
        expect(toMessages([row()])).toHaveLength(1);
    });

    it("returns [] for junk / missing shapes and drops unparseable rows", () => {
        expect(toMessages(null)).toEqual([]);
        expect(toMessages({})).toEqual([]);
        expect(toMessages("nope")).toEqual([]);
        expect(toMessages([{garbage: true}, row()])).toHaveLength(1); // bad row dropped, good kept
    });
});

const msg = (id: string, clientId?: string): ChatMessage => ({
    id, clientId, chatId: "c1", from: "peer", to: "me", text: "x",
    createdAt: new Date(0), status: "sent",
} as ChatMessage);

describe("reconcileHistory.dedupMessages", () => {
    it("drops a duplicate by id", () => {
        expect(dedupMessages([msg("a"), msg("a"), msg("b")]).map((m) => m.id)).toEqual(["a", "b"]);
    });

    it("collapses an echo and its server row that share a clientId", () => {
        // Same message: an echo (id == clientId) and the server row (server id, same clientId).
        const out = dedupMessages([msg("temp", "temp"), msg("01SERVER", "temp")]);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe("temp"); // first seen wins
    });

    it("keeps distinct messages", () => {
        expect(dedupMessages([msg("a"), msg("b"), msg("c")])).toHaveLength(3);
    });
});
