import {describe, it, expect, afterEach, vi} from "vitest";
import {declineFrame, isActiveCall} from "../useNativeCall.ts";
import {toWire} from "@/infrastructure/ws/frameBridge.ts";
import {callPlugin} from "@/shared/platform.ts";
import callReducer, {answerViaPush, incomingOffer, localEnd} from "@/features/call/model/slices/callSlice";

const g = globalThis as { Capacitor?: unknown };

describe("native calls (S1 §4.5, §5.3, §7.3)", () => {
    afterEach(() => { delete g.Capacitor; });

    it("the call service runs for calling / connecting / in_call only", () => {
        expect(isActiveCall("calling")).toBe(true);
        expect(isActiveCall("connecting")).toBe(true);
        expect(isActiveCall("in_call")).toBe(true);
        expect(isActiveCall("ringing")).toBe(false);
        expect(isActiveCall("idle")).toBe(false);
    });

    it("callDecline → the same SIGNAL_IN call:end the native side would send", () => {
        const w = toWire(declineFrame({conversationId: "c1", callerId: "u2"}) as never) as Record<string, unknown>;
        expect(w.type).toBe("SIGNAL_IN");
        expect(w.recipientId).toBe("u2");
        expect(w.conversationId).toBe("c1");
        expect(JSON.parse((w.payload as {body: string}).body)).toEqual({type: "call:end"});
    });

    it("callPlugin() only in the app", () => {
        expect(() => callPlugin()).toThrow();
        const Call = {started: vi.fn()};
        g.Capacitor = {isNativePlatform: () => true, Plugins: {Call}};
        expect(callPlugin()).toBe(Call);
    });

    it("autoAcceptFrom: set by an accepted push answer, cleared by the offer and by any end", () => {
        let s = callReducer(undefined, answerViaPush({peerId: "u2", conversationId: "c1", autoAccept: true}));
        expect(s.autoAcceptFrom).toBe("u2");
        expect(callReducer(s, incomingOffer({from: "u2", sdp: "x"} as never)).autoAcceptFrom).toBeNull();
        expect(callReducer(s, localEnd()).autoAcceptFrom).toBeNull();
        s = callReducer(undefined, answerViaPush({peerId: "u2", conversationId: "c1"}));
        expect(s.autoAcceptFrom).toBeNull();
    });
});
