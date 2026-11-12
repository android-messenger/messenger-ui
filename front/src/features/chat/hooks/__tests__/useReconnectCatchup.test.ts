import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";
import {renderHook, act} from "@testing-library/react";
import {createElement, type ReactNode} from "react";
import {Provider} from "react-redux";
import {configureStore} from "@reduxjs/toolkit";

vi.mock("@/features/chat/model/services/chatMessages.service.ts", () => ({
    chatMessagesService: {refetchChatsPreservingSelected: vi.fn()},
}));
vi.mock("@/features/chat/thunk/sendOutboxThunk.ts", () => ({
    flushOutbox: vi.fn(() => ({type: "test/flushOutbox"})),
}));

import {useReconnectCatchup} from "../useReconnectCatchup";
import {chatMessagesService} from "@/features/chat/model/services/chatMessages.service.ts";
import {flushOutbox} from "@/features/chat/thunk/sendOutboxThunk.ts";

const refetch = vi.mocked(chatMessagesService.refetchChatsPreservingSelected);
const flush = vi.mocked(flushOutbox);

function setVisibility(v: "visible" | "hidden") {
    Object.defineProperty(document, "visibilityState", {configurable: true, get: () => v});
}

function makeStore(initialStatus: string) {
    return configureStore({
        reducer: {
            ws: (state = {status: initialStatus}, action: {type: string; status?: string}) =>
                action.type === "test/ws" ? {status: action.status!} : state,
        },
    });
}

function wrap(store: ReturnType<typeof makeStore>) {
    return ({children}: {children: ReactNode}) => createElement(Provider, {store, children});
}

beforeEach(() => {
    refetch.mockClear();
    flush.mockClear();
    setVisibility("visible");
});
afterEach(() => setVisibility("visible"));

describe("useReconnectCatchup", () => {
    it("does nothing on mount while already connected (no false transition)", () => {
        const store = makeStore("connected");
        const reload = vi.fn(() => Promise.resolve());
        renderHook(() => useReconnectCatchup({selectedChatId: "c1", reloadChatHistory: reload}), {wrapper: wrap(store)});
        expect(flush).not.toHaveBeenCalled();
        expect(refetch).not.toHaveBeenCalled();
    });

    it("on disconnected→connected transition: resends outbox, refreshes list + open history", () => {
        const store = makeStore("disconnected");
        const reload = vi.fn(() => Promise.resolve());
        renderHook(() => useReconnectCatchup({selectedChatId: "c1", reloadChatHistory: reload}), {wrapper: wrap(store)});
        // Mount while disconnected → no catch-up yet.
        expect(flush).not.toHaveBeenCalled();
        act(() => { store.dispatch({type: "test/ws", status: "connected"}); });
        expect(flush).toHaveBeenCalledTimes(1);
        expect(refetch).toHaveBeenCalledTimes(1);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("does NOT re-fire on a connected→connected re-render (chat switch, not a reconnect)", () => {
        const store = makeStore("connected");
        const reload = vi.fn(() => Promise.resolve());
        const {rerender} = renderHook(
            (props: {id: string}) => useReconnectCatchup({selectedChatId: props.id, reloadChatHistory: reload}),
            {wrapper: wrap(store), initialProps: {id: "c1"}});
        rerender({id: "c2"}); // switch chats while staying connected
        expect(flush).not.toHaveBeenCalled();
        expect(refetch).not.toHaveBeenCalled();
    });

    it("does not catch up on the transition's history reload when no chat is open", () => {
        const store = makeStore("disconnected");
        const reload = vi.fn(() => Promise.resolve());
        renderHook(() => useReconnectCatchup({selectedChatId: null, reloadChatHistory: reload}), {wrapper: wrap(store)});
        act(() => { store.dispatch({type: "test/ws", status: "connected"}); });
        expect(refetch).toHaveBeenCalledTimes(1); // list still refreshes
        expect(reload).not.toHaveBeenCalled();     // but no open chat → no history reload
    });

    it("resume while visible refreshes list + open history", () => {
        setVisibility("visible");
        const store = makeStore("connected");
        const reload = vi.fn(() => Promise.resolve());
        renderHook(() => useReconnectCatchup({selectedChatId: "c1", reloadChatHistory: reload}), {wrapper: wrap(store)});
        act(() => { document.dispatchEvent(new Event("visibilitychange")); });
        expect(refetch).toHaveBeenCalledTimes(1);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("resume while hidden does nothing", () => {
        setVisibility("hidden");
        const store = makeStore("connected");
        const reload = vi.fn(() => Promise.resolve());
        renderHook(() => useReconnectCatchup({selectedChatId: "c1", reloadChatHistory: reload}), {wrapper: wrap(store)});
        act(() => { document.dispatchEvent(new Event("visibilitychange")); });
        expect(refetch).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
    });
});
