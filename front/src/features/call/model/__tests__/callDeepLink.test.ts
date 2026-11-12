import { describe, it, expect } from "vitest";
import { parseCallDeepLink } from "../callDeepLink";

describe("parseCallDeepLink", () => {
    it("carries BOTH the conversationId (call) and the peer (caller) — the regression that broke calling from a notification", () => {
        const out = parseCallDeepLink(new URLSearchParams("call=conv-1&caller=user-2"));
        // conversationId MUST be present so a cold start doesn't fail the has-a-conversation guard.
        expect(out).toEqual({ conversationId: "conv-1", peerId: "user-2" });
    });

    it("parses the optional media hint (audio) when present", () => {
        expect(parseCallDeepLink(new URLSearchParams("call=conv-1&caller=user-2&media=audio")))
            .toEqual({ conversationId: "conv-1", peerId: "user-2", media: "audio" });
    });

    it("leaves media undefined for an unknown/absent value", () => {
        expect(parseCallDeepLink(new URLSearchParams("call=conv-1&caller=user-2&media=bogus")))
            .toEqual({ conversationId: "conv-1", peerId: "user-2", media: undefined });
    });

    it("accept=1 in the address means nothing: a link cannot answer a call (audit 2026-11-12, finding Б)", () => {
        expect(parseCallDeepLink(new URLSearchParams("call=conv-1&caller=user-2&media=video&accept=1")))
            .toEqual({ conversationId: "conv-1", peerId: "user-2", media: "video" });
        expect(parseCallDeepLink(new URLSearchParams("call=conv-1&caller=user-2&accept=yes")))
            .toEqual({ conversationId: "conv-1", peerId: "user-2", media: undefined });
    });

    it("returns null when the caller is missing (can't call back an unknown peer)", () => {
        expect(parseCallDeepLink(new URLSearchParams("call=conv-1"))).toBeNull();
    });

    it("returns null when the conversationId is missing", () => {
        expect(parseCallDeepLink(new URLSearchParams("caller=user-2"))).toBeNull();
    });

    it("returns null for a non-call link (e.g. a plain ?chat= message deep link)", () => {
        expect(parseCallDeepLink(new URLSearchParams("chat=conv-1"))).toBeNull();
    });
});
