import {describe, it, expect, vi, beforeEach} from "vitest";
import {renderHook} from "@testing-library/react";

const state = {call: {status: "idle", peerId: null as string | null, audioOnly: false, conversationId: null as string | null}, secretChats: {byId: {} as Record<string, boolean>}};
vi.mock("react-redux", () => ({
    useDispatch: () => "dispatch",
    useSelector: (sel: (s: unknown) => unknown) => sel(state),
    useStore: () => ({getState: () => state}),
}));
vi.mock("react-i18next", () => ({useTranslation: () => ({t: (k: string) => k})}));
const enqueue = vi.fn();
vi.mock("@/features/chat/model/services/chatMessages.service.ts", () => ({chatMessagesService: {enqueueChatMessage: (...a: unknown[]) => enqueue(...a)}}));
vi.mock("@/features/chat/model/directDirectory.ts", () => ({selectCallConversationId: (_s: unknown, peer: string) => (peer === "peer" ? "c1" : undefined)}));
const lists = {ready: true};
vi.mock("@/features/chat/model/sealedLists.ts", () => ({listsReady: () => lists.ready}));

import {useMissedCallNote} from "../useMissedCallNote";

const getSummary = (id: string) => (id === "c1" ? {counterpartId: "peer"} : null);
const set = (status: string, peerId: string | null = null, audioOnly = false) => { Object.assign(state.call, {status, peerId, audioOnly}); };
const run = () => renderHook(() => useMissedCallNote({myId: "me", getSummary}));

describe("useMissedCallNote", () => {
    beforeEach(() => { enqueue.mockClear(); set("idle"); state.call.conversationId = null; state.secretChats.byId = {}; lists.ready = true; });

    it("an outgoing call that ends unanswered leaves one line in the chat", () => {
        set("calling", "peer", true);
        const h = run();
        expect(enqueue).not.toHaveBeenCalled();
        set("idle"); h.rerender();
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(enqueue).toHaveBeenCalledWith("dispatch", "📞 chat.missedCall", "me", "c1", "peer", undefined, false, {call: "missed", media: "audio"});
        h.rerender();
        expect(enqueue).toHaveBeenCalledTimes(1);   // once per call
    });

    it("a video call is marked as video, and a secret chat gets the line encrypted", () => {
        state.secretChats.byId = {c1: true};
        set("calling", "peer", false);
        const h = run();
        set("idle"); h.rerender();
        expect(enqueue).toHaveBeenCalledWith("dispatch", "📞 chat.missedVideoCall", "me", "c1", "peer", undefined, true, {call: "missed", media: "video"});
    });

    it("an answered call leaves nothing, also when it ends later", () => {
        set("calling", "peer");
        const h = run();
        set("connecting", "peer"); h.rerender();
        set("in_call", "peer"); h.rerender();
        set("idle"); h.rerender();
        expect(enqueue).not.toHaveBeenCalled();
    });

    it("an incoming call I did not answer leaves nothing from my side: the caller writes the line", () => {
        set("ringing", "peer");
        const h = run();
        set("idle"); h.rerender();
        expect(enqueue).not.toHaveBeenCalled();
    });

    it("no chat to write to, or lists not read yet: nothing is sent", () => {
        set("calling", "stranger");
        const h = run();
        set("idle"); h.rerender();
        lists.ready = false;
        set("calling", "peer"); h.rerender();
        set("idle"); h.rerender();
        expect(enqueue).not.toHaveBeenCalled();
    });
});
