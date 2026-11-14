import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";
import {renderHook, act} from "@testing-library/react";
import {createElement, type ReactNode} from "react";
import {Provider} from "react-redux";
import {configureStore} from "@reduxjs/toolkit";

vi.mock("@/features/chat/model/services/chatMessages.service.ts", () => ({
    chatMessagesService: {refetchChatsPreservingSelected: vi.fn(async () => {}), probeUnread: vi.fn(async () => {})},
}));
vi.mock("@/features/chat/thunk/sendOutboxThunk.ts", () => ({
    flushOutbox: vi.fn(() => ({type: "test/flushOutbox"})),
}));

import {useReconnectCatchup, resetUnreadAsked} from "../useReconnectCatchup";
import {chatMessagesService} from "@/features/chat/model/services/chatMessages.service.ts";
import {flushOutbox} from "@/features/chat/thunk/sendOutboxThunk.ts";
import {forgetHistorySync, markStale, noteHistoryRead} from "@/features/chat/model/historySync.ts";

const refetch = vi.mocked(chatMessagesService.refetchChatsPreservingSelected);
const flush = vi.mocked(flushOutbox);
const probe = vi.mocked(chatMessagesService.probeUnread);

function setVisibility(v: "visible" | "hidden") {
    Object.defineProperty(document, "visibilityState", {configurable: true, get: () => v});
}

function makeStore(initialStatus: string) {
    return configureStore({
        reducer: {
            // epoch: the number of the socket's connection, +1 on every connect (as in websocketSlice)
            ws: (state = {status: initialStatus, epoch: initialStatus === "connected" ? 1 : 0}, action: {type: string; status?: string}) =>
                action.type === "test/ws"
                    ? {status: action.status!, epoch: state.epoch + (action.status === "connected" ? 1 : 0)}
                    : state,
        },
    });
}

/** The chat's history was read from the server under the current connection: it is complete. */
function complete(store: ReturnType<typeof makeStore>, chatId: string) {
    noteHistoryRead(chatId, store.getState().ws.epoch, store.getState().ws);
}

function wrap(store: ReturnType<typeof makeStore>) {
    return ({children}: {children: ReactNode}) => createElement(Provider, {store, children});
}

beforeEach(() => {
    refetch.mockClear();
    flush.mockClear();
    probe.mockClear();
    resetUnreadAsked();
    forgetHistorySync();
    setVisibility("visible");
});
afterEach(() => setVisibility("visible"));

describe("useReconnectCatchup", () => {
    it("does nothing on mount while already connected (no false transition)", () => {
        const store = makeStore("connected");
        const reload = vi.fn(() => Promise.resolve());
        renderHook(() => useReconnectCatchup({selectedChatId: "c1", reloadChatHistory: reload}), {wrapper: wrap(store)});
        expect(flush).not.toHaveBeenCalled();
        expect(refetch).toHaveBeenCalledTimes(1);       // the unread check of this connection (spec 002 §3.2), nothing else
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
        expect(refetch).toHaveBeenCalledTimes(1);       // once for the connection, not again for the switch
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
        complete(store, "c1");
        const reload = vi.fn(() => Promise.resolve());
        renderHook(() => useReconnectCatchup({selectedChatId: "c1", reloadChatHistory: reload}), {wrapper: wrap(store)});
        refetch.mockClear();
        act(() => { document.dispatchEvent(new Event("visibilitychange")); });
        expect(refetch).toHaveBeenCalledTimes(1);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("resume while hidden does nothing", () => {
        setVisibility("hidden");
        const store = makeStore("connected");
        complete(store, "c1");
        const reload = vi.fn(() => Promise.resolve());
        renderHook(() => useReconnectCatchup({selectedChatId: "c1", reloadChatHistory: reload}), {wrapper: wrap(store)});
        refetch.mockClear();
        act(() => { document.dispatchEvent(new Event("visibilitychange")); });
        expect(refetch).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
    });

    // ---- spec 002 §3.1: the sign that the socket had a gap ----
    it("a chat opened stale is read; a chat that is complete is not read again", () => {
        const store = makeStore("connected");
        complete(store, "c1");
        const reload = vi.fn(() => Promise.resolve());
        const {rerender} = renderHook(
            (props: {id: string}) => useReconnectCatchup({selectedChatId: props.id, reloadChatHistory: reload}),
            {wrapper: wrap(store), initialProps: {id: "c1"}});
        expect(reload).not.toHaveBeenCalled();          // c1 is complete
        rerender({id: "c2"});                            // c2 was never read under this connection
        expect(reload).toHaveBeenCalledTimes(1);
        complete(store, "c2");
        rerender({id: "c1"});                            // back to a complete chat: no request
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("after a gap the chat on screen is read once the socket is back, whatever closed it", () => {
        const store = makeStore("connected");
        complete(store, "c1");
        const reload = vi.fn(() => Promise.resolve());
        renderHook(() => useReconnectCatchup({selectedChatId: "c1", reloadChatHistory: reload}), {wrapper: wrap(store)});
        act(() => { store.dispatch({type: "test/ws", status: "disconnected"}); });
        expect(reload).not.toHaveBeenCalled();          // nothing to read from while the socket is down
        act(() => { store.dispatch({type: "test/ws", status: "connected"}); });
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("a notification tap that opens a chat before the socket is back: the chat is read when it connects", () => {
        const store = makeStore("disconnected");
        const reload = vi.fn(() => Promise.resolve());
        const {rerender} = renderHook(
            (props: {id: string | null}) => useReconnectCatchup({selectedChatId: props.id, reloadChatHistory: reload}),
            {wrapper: wrap(store), initialProps: {id: null as string | null}});
        rerender({id: "c9"});                            // the tap
        expect(reload).not.toHaveBeenCalled();
        act(() => { store.dispatch({type: "test/ws", status: "connected"}); });
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("markStale is how a push or a tap asks for one chat to be read again", () => {
        const store = makeStore("connected");
        complete(store, "c1");
        expect(store.getState().ws.epoch).toBe(1);
        markStale("c1");
        const reload = vi.fn(() => Promise.resolve());
        renderHook(() => useReconnectCatchup({selectedChatId: "c1", reloadChatHistory: reload}), {wrapper: wrap(store)});
        expect(reload).toHaveBeenCalledTimes(1);
    });

    // ---- spec 002 §3.2: unread marks from the server ----
    it("asks the server for unread marks once per connection: at the start and after every gap", async () => {
        const store = makeStore("connected");
        const reload = vi.fn(() => Promise.resolve());
        const {rerender, unmount} = renderHook(
            (props: {id: string | null}) => useReconnectCatchup({selectedChatId: props.id, reloadChatHistory: reload}),
            {wrapper: wrap(store), initialProps: {id: null as string | null}});
        await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
        rerender({id: "c1"});
        unmount();
        renderHook(() => useReconnectCatchup({selectedChatId: null, reloadChatHistory: reload}), {wrapper: wrap(store)});
        await new Promise((r) => setTimeout(r, 20));
        expect(probe).toHaveBeenCalledTimes(1);          // the page mounted again under the same connection
        act(() => { store.dispatch({type: "test/ws", status: "disconnected"}); });
        act(() => { store.dispatch({type: "test/ws", status: "connected"}); });
        await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    });
});
