import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";
import {toWire, fromWire} from "../frameBridge";
import type {WSMessage, OutgoingWSMessage} from "@/infrastructure/types.ts";

const asPayload = (m: WSMessage) => m.payload as {kind?: string; body?: string};

beforeEach(() => vi.stubGlobal("crypto", {randomUUID: () => "uuid-1"}));
afterEach(() => vi.unstubAllGlobals());

describe("frameBridge — toWire", () => {
    it("wraps a call:offer action into SIGNAL_IN (to→recipientId, body JSON, `to` stripped from body)", () => {
        const offer = {type: "offer", sdp: "x"};
        const out = toWire({type: "call:offer", to: "u2", offer} as OutgoingWSMessage, {conversationId: "c1"});
        expect(out.type).toBe("SIGNAL_IN");
        expect(out.recipientId).toBe("u2");
        expect(out.conversationId).toBe("c1");
        expect(out.messageId).toBe("uuid-1");
        expect(asPayload(out).kind).toBe("event");
        expect(JSON.parse(asPayload(out).body as string)).toEqual({type: "call:offer", offer});
    });

    it("passes a non-call frame through unchanged", () => {
        const frame = {type: "CHAT_IN", conversationId: "c1", messageId: "m1"} as OutgoingWSMessage;
        expect(toWire(frame)).toBe(frame);
    });
});

describe("frameBridge — fromWire", () => {
    it("unwraps SIGNAL_OUT.payload.body and sets from = senderId", () => {
        const answer = {type: "answer", sdp: "y"};
        const inner = {type: "call:answer", answer};
        const out = fromWire({type: "SIGNAL_OUT", senderId: "u9", payload: {body: JSON.stringify(inner)}});
        expect(out).toEqual({type: "call:answer", answer, from: "u9"});
    });

    it("passes a non-SIGNAL_OUT frame through unchanged", () => {
        const frame = {type: "CHAT_OUT", messageId: "m2"};
        expect(fromWire(frame)).toBe(frame);
    });
});
