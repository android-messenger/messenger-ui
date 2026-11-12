import {describe, it, expect} from "vitest";
import {buildChatIn, buildReadIn, buildTypingIn} from "../wireMessage.schema.ts";

describe("wire builders — recipientId omission (group vs 1:1)", () => {
    it("buildChatIn includes recipientId for a 1:1 send", () => {
        const f = buildChatIn({conversationId: "c1", recipientId: "peer", messageId: "m1", body: "hi"});
        expect(f).toMatchObject({type: "CHAT_IN", conversationId: "c1", recipientId: "peer"});
        expect(f.payload).toMatchObject({kind: "text", body: "hi"});
    });

    it("buildChatIn OMITS recipientId for a group send (empty/undefined)", () => {
        expect("recipientId" in buildChatIn({conversationId: "g1", recipientId: "", messageId: "m1", body: "hi"})).toBe(false);
        expect("recipientId" in buildChatIn({conversationId: "g1", messageId: "m1", body: "hi"})).toBe(false);
    });

    it("buildTypingIn includes/omits recipientId accordingly", () => {
        expect(buildTypingIn("c1", "peer")).toMatchObject({type: "TYPING_IN", recipientId: "peer", conversationId: "c1"});
        expect("recipientId" in buildTypingIn("g1", "")).toBe(false);
    });

    it("buildReadIn includes/omits recipientId, always carrying the boundary in correlationId", () => {
        const direct = buildReadIn("c1", "peer", "01ULIDBOUNDARY");
        expect(direct).toMatchObject({type: "READ_IN", recipientId: "peer", conversationId: "c1", correlationId: "01ULIDBOUNDARY"});
        expect("recipientId" in buildReadIn("g1", "", "01ULIDBOUNDARY")).toBe(false);
    });
});
