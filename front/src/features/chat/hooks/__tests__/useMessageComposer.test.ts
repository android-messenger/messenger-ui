import {describe, it, expect, vi, beforeEach} from "vitest";
import {renderHook, act} from "@testing-library/react";
import {createElement, type ReactNode} from "react";
import {Provider} from "react-redux";
import {configureStore} from "@reduxjs/toolkit";

vi.mock("@/features/chat/model/services/chatMessages.service.ts", () => ({
    chatMessagesService: {enqueueChatMessage: vi.fn()},
}));
vi.mock("react-hot-toast", () => ({default: {error: vi.fn(), success: vi.fn()}}));
vi.mock("react-i18next", () => ({useTranslation: () => ({t: (k: string) => k})}));

import {useMessageComposer} from "../useMessageComposer";
import {chatMessagesService} from "@/features/chat/model/services/chatMessages.service.ts";
import toast from "react-hot-toast";
import {clearAllDrafts, loadDraft} from "@/features/chat/model/drafts.ts";

const enqueue = vi.mocked(chatMessagesService.enqueueChatMessage);
const MY = "me";
const summaries: Record<string, {counterpartId: string; orderId?: string}> = {};
const getSummary = (id: string) => summaries[id];

function makeHarness() {
    const sent: Array<{type: string; payload?: unknown}> = [];
    const recorder = () => (next: (a: unknown) => unknown) => (action: unknown) => {
        const a = action as {type: string};
        if (a?.type === "ws/send") sent.push(a as {type: string; payload?: unknown});
        return next(action);
    };
    const store = configureStore({
        reducer: {noop: (s = {}) => s},
        middleware: (gDM) => gDM().concat(recorder),
    });
    const wrapper = ({children}: {children: ReactNode}) => createElement(Provider, {store, children});
    return {wrapper, sent};
}

beforeEach(() => {
    clearAllDrafts();
    localStorage.clear();
    enqueue.mockClear();
    vi.mocked(toast.error).mockClear();
    for (const k of Object.keys(summaries)) delete summaries[k];
});

describe("useMessageComposer", () => {
    it("ignores empty / whitespace-only text", () => {
        summaries["c1"] = {counterpartId: "peer"};
        const {wrapper} = makeHarness();
        const {result} = renderHook(() => useMessageComposer({selectedChatId: "c1", myId: MY, getSummary}), {wrapper});
        act(() => { result.current.sendMessage("   "); });
        expect(enqueue).not.toHaveBeenCalled();
    });

    it("errors (no send) when the conversation can't be resolved", () => {
        const {wrapper} = makeHarness();
        const {result} = renderHook(() => useMessageComposer({selectedChatId: "c1", myId: MY, getSummary}), {wrapper});
        act(() => { result.current.sendMessage("hi"); }); // no summary for c1
        expect(enqueue).not.toHaveBeenCalled();
        expect(toast.error).toHaveBeenCalled();
    });

    it("enqueues the message with the summary's counterpart + order, and clears the input", () => {
        summaries["c1"] = {counterpartId: "peer", orderId: "o1"};
        const {wrapper} = makeHarness();
        const {result} = renderHook(() => useMessageComposer({selectedChatId: "c1", myId: MY, getSummary}), {wrapper});
        act(() => { result.current.setMessageInput("draft"); });
        expect(result.current.messageInput).toBe("draft");
        act(() => { result.current.sendMessage("hello"); });
        expect(enqueue).toHaveBeenCalledTimes(1);
        const args = enqueue.mock.calls[0];
        // (dispatch, text, myId, chatId, counterpartId, orderId, secret)
        expect(args.slice(1)).toEqual(["hello", MY, "c1", "peer", "o1", false]);   // false = not a secret chat
        expect(result.current.messageInput).toBe("");
    });

    it("forwardMessage enqueues into the TARGET chat, honoring the TARGET's secret setting", () => {
        summaries["t-secret"] = {counterpartId: "ps"};
        summaries["t-plain"] = {counterpartId: "pp"};
        const store = configureStore({
            reducer: {secretChats: (s: {byId: Record<string, true>} = {byId: {"t-secret": true}}) => s},
        });
        const wrapper = ({children}: {children: ReactNode}) => createElement(Provider, {store, children});
        const {result} = renderHook(() => useMessageComposer({selectedChatId: "src", myId: MY, getSummary}), {wrapper});
        act(() => { result.current.forwardMessage("t-secret", "hi"); });
        act(() => { result.current.forwardMessage("t-plain", "hi"); });
        // (dispatch, text, myId, chatId, counterpartId, orderId, secret) — secret follows the TARGET chat.
        expect(enqueue.mock.calls[0].slice(1)).toEqual(["hi", MY, "t-secret", "ps", undefined, true]);
        expect(enqueue.mock.calls[1].slice(1)).toEqual(["hi", MY, "t-plain", "pp", undefined, false]);
    });

    it("forwardMessage no-ops on empty text or an unresolvable target", () => {
        const {wrapper} = makeHarness();
        const {result} = renderHook(() => useMessageComposer({selectedChatId: "src", myId: MY, getSummary}), {wrapper});
        act(() => { result.current.forwardMessage("t", "   "); });   // blank
        act(() => { result.current.forwardMessage("t", "hi"); });    // no summary for "t"
        expect(enqueue).not.toHaveBeenCalled();
        expect(toast.error).toHaveBeenCalled();
    });

    it("notifyTyping sends TYPING_IN, throttled to one frame per burst", () => {
        summaries["c1"] = {counterpartId: "peer"};
        const {wrapper, sent} = makeHarness();
        const {result} = renderHook(() => useMessageComposer({selectedChatId: "c1", myId: MY, getSummary}), {wrapper});
        act(() => { result.current.notifyTyping(); result.current.notifyTyping(); });
        expect(sent).toHaveLength(1); // second call within the 2.5s window is throttled
        expect((sent[0].payload as {type: string}).type).toBe("TYPING_IN");
    });

    it("notifyTyping does nothing without an open chat", () => {
        const {wrapper, sent} = makeHarness();
        const {result} = renderHook(() => useMessageComposer({selectedChatId: null, myId: MY, getSummary}), {wrapper});
        act(() => { result.current.notifyTyping(); });
        expect(sent).toHaveLength(0);
    });

    it("a secret chat's draft is kept in memory only; an ordinary chat's draft is persisted", () => {
        const store = configureStore({
            reducer: {secretChats: (s: {byId: Record<string, true>} = {byId: {"c-secret": true}}) => s},
        });
        const wrapper = ({children}: {children: ReactNode}) => createElement(Provider, {store, children});
        const KEY = "wolp.drafts.v1";

        const secret = renderHook(() => useMessageComposer({selectedChatId: "c-secret", myId: MY, getSummary}), {wrapper});
        act(() => { secret.result.current.setMessageInput("secret words"); });
        expect(secret.result.current.messageInput).toBe("secret words");
        expect(localStorage.getItem(KEY)).toBeNull();          // nothing on disk
        expect(loadDraft("c-secret")).toBe("secret words");    // survives switching chats (memory)

        const plain = renderHook(() => useMessageComposer({selectedChatId: "c-plain", myId: MY, getSummary}), {wrapper});
        act(() => { plain.result.current.setMessageInput("ordinary words"); });
        expect(localStorage.getItem(KEY)).toContain("ordinary words");
        expect(localStorage.getItem(KEY)).not.toContain("secret words");
    });
});
