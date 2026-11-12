// Audit 2026-11-12, finding Б: a link https://<ui>/?call=<conv>&caller=<attacker>&accept=1 used to switch on
// silent auto-answer for the attacker's next call. Written by the auditor as a PoC of the hole; the
// assertions now state the fixed behaviour: nothing in the address answers a call, the answer given on the
// app's native screen comes as a plugin event, is bound to that call, is used once and has a lifetime.
import {describe, it, expect, vi, beforeEach} from "vitest";
import {configureStore} from "@reduxjs/toolkit";
import {tapRoute} from "@/infrastructure/native/tapRoute.ts";
import {parseCallDeepLink} from "@/features/call/model/callDeepLink.ts";
import {noteNativeAccept, takeNativeAccept, NATIVE_ACCEPT_TTL_MS} from "@/features/call/model/nativeAccept.ts";
import callReducer, {answerViaPush, acceptCall} from "@/features/call/model/slices/callSlice";
import {createCallMiddleware} from "@/features/call/middleware/callMiddleware";

vi.mock("@/features/notifications", () => ({showCallNotification: vi.fn()}));

function client() {
    const webRTC = {
        signalReady: vi.fn(), handleOffer: vi.fn(() => Promise.resolve()), declineOffer: vi.fn(),
        endRemote: vi.fn(), resendOffer: vi.fn(), getConnectionState: vi.fn(() => null),
    };
    const seen: string[] = [];
    const store = configureStore({
        reducer: {call: callReducer, ws: () => ({status: "connected"}), user: () => ({id: "VICTIM"})},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        middleware: (g) => g({serializableCheck: false}).concat(createCallMiddleware(webRTC as any) as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            () => (next: any) => (a: any) => { seen.push(a.type); return next(a); }),
    });
    /** What pages/Messenger.tsx does with the address of the page. */
    const openLink = (query: string) => {
        const link = parseCallDeepLink(new URLSearchParams(query))!;
        store.dispatch(answerViaPush({peerId: link.peerId, conversationId: link.conversationId, media: link.media,
            autoAccept: takeNativeAccept(link.peerId, link.conversationId)}));
    };
    const offerFrom = (from: string, conversationId: string) =>
        store.dispatch({type: "ws/incoming", payload: {type: "call:offer", from, sdp: "ENC", conversationId}});
    return {webRTC, seen, store, openLink, offerFrom};
}

describe("audit, finding Б: a call is answered only by the user", () => {
    beforeEach(() => { takeNativeAccept("CALLER", "conv"); vi.useRealTimers(); });

    it("a link with accept=1 → the attacker's offer rings, it is not accepted", () => {
        const {seen, store, openLink, offerFrom, webRTC} = client();
        openLink("call=any-conversation&caller=ATTACKER&media=video&accept=1");
        expect(store.getState().call.autoAcceptFrom).toBeNull();

        offerFrom("ATTACKER", "any-conversation");
        expect(seen).not.toContain(acceptCall.type);
        expect(store.getState().call.status).toBe("ringing");
        expect(webRTC.handleOffer).not.toHaveBeenCalled();
    });

    it("the route of a notification tap never carries the answer", () => {
        expect(tapRoute({call: {conversationId: "conv", callerId: "CALLER", media: "video", accept: true}})).toBe("/?call=conv&caller=CALLER&media=video");
    });

    it("«Принять» on the native screen → that caller's offer is accepted, once", () => {
        const {seen, store, openLink, offerFrom} = client();
        noteNativeAccept("CALLER", "conv");                    // the Push plugin's notificationTap event
        openLink("call=conv&caller=CALLER&media=video");
        expect(store.getState().call.autoAcceptFrom).toBe("CALLER");
        offerFrom("CALLER", "conv");
        expect(seen).toContain(acceptCall.type);
        expect(takeNativeAccept("CALLER", "conv")).toBe(false); // used
    });

    it("the answer is for that caller and that conversation only", () => {
        noteNativeAccept("CALLER", "conv");
        expect(takeNativeAccept("ATTACKER", "conv")).toBe(false);
        expect(takeNativeAccept("CALLER", "another")).toBe(false);
        expect(takeNativeAccept("CALLER", "conv")).toBe(true);
    });

    it("the answer has a lifetime: before the link is opened and after it", () => {
        const t0 = 1_000_000;
        noteNativeAccept("CALLER", "conv", t0);
        expect(takeNativeAccept("CALLER", "conv", t0 + NATIVE_ACCEPT_TTL_MS)).toBe(false);

        vi.useFakeTimers();
        vi.setSystemTime(t0);
        const {seen, store, openLink, offerFrom} = client();
        noteNativeAccept("CALLER", "conv");
        openLink("call=conv&caller=CALLER");
        vi.setSystemTime(t0 + 46_000);                         // no offer came; the caller calls again later
        offerFrom("CALLER", "conv");
        expect(seen).not.toContain(acceptCall.type);
        expect(store.getState().call.status).toBe("ringing");
    });
});
