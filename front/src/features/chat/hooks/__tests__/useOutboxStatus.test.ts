import {describe, it, expect, vi, beforeEach} from "vitest";
import {renderHook, act} from "@testing-library/react";
import {createElement, type ReactNode} from "react";
import {Provider} from "react-redux";
import {configureStore} from "@reduxjs/toolkit";

vi.mock("@/features/chat/thunk/sendOutboxThunk.ts", () => ({
    flushOutbox: vi.fn(() => ({type: "test/flushOutbox"})),
}));

import {useOutboxStatus} from "../useOutboxStatus";
import outboxReducer, {enqueueMessage} from "@/features/chat/model/slices/outboxSlice";
import {chatApi} from "@/features/chat/rest/chatApi";
import {flushOutbox} from "@/features/chat/thunk/sendOutboxThunk.ts";

const flush = vi.mocked(flushOutbox);
const MY = "me";

function outboxMsg(id: string) {
    return {id, idempotencyKey: id, status: "pending" as const, attempts: 0, payload: {type: "CHAT_IN", messageId: id}};
}

async function makeHarness(history?: Array<{id: string}>) {
    const actions: Array<{type: string}> = [];
    const recorder = () => (next: (a: unknown) => unknown) => (action: unknown) => {
        actions.push(action as {type: string});
        return next(action);
    };
    const store = configureStore({
        reducer: {outbox: outboxReducer, [chatApi.reducerPath]: chatApi.reducer},
        middleware: (gDM) => gDM({serializableCheck: false}).concat(chatApi.middleware, recorder),
    });
    if (history) {
        await store.dispatch(chatApi.util.upsertQueryData("getChatHistory", {myId: MY, chatId: "c1"}, history as never));
    }
    const wrapper = ({children}: {children: ReactNode}) => createElement(Provider, {store, children});
    return {store, wrapper, actions};
}

const historyIds = (store: ReturnType<typeof configureStore>) =>
    (chatApi.endpoints.getChatHistory.select({myId: MY, chatId: "c1"})(store.getState() as never)?.data ?? []).map((m) => m.id);

beforeEach(() => flush.mockClear());

describe("useOutboxStatus", () => {
    it("projects the outbox into an id→status map", async () => {
        const {store, wrapper} = await makeHarness();
        act(() => { store.dispatch(enqueueMessage(outboxMsg("m1"))); });
        const {result} = renderHook(() => useOutboxStatus({selectedChatId: "c1", myId: MY}), {wrapper});
        expect(result.current.outboxStatusById["m1"]).toBe("pending");
    });

    it("retryMessage re-queues the message and flushes the outbox", async () => {
        const {store, wrapper, actions} = await makeHarness();
        act(() => { store.dispatch(enqueueMessage(outboxMsg("m1"))); });
        const {result} = renderHook(() => useOutboxStatus({selectedChatId: "c1", myId: MY}), {wrapper});
        act(() => { result.current.retryMessage("m1"); });
        expect(actions.some((a) => a.type === "outbox/retryMessage")).toBe(true);
        expect(flush).toHaveBeenCalledTimes(1);
    });

    it("discardMessage drops the outbox entry AND splices the optimistic row out of the open history", async () => {
        const {store, wrapper, actions} = await makeHarness([{id: "m1"}, {id: "m2"}]);
        act(() => { store.dispatch(enqueueMessage(outboxMsg("m1"))); });
        const {result} = renderHook(() => useOutboxStatus({selectedChatId: "c1", myId: MY}), {wrapper});
        act(() => { result.current.discardMessage("m1"); });
        expect(actions.some((a) => a.type === "outbox/discardMessage")).toBe(true);
        expect(historyIds(store)).toEqual(["m2"]); // optimistic m1 removed, m2 kept
    });

    it("discardMessage without an open chat still drops the outbox entry (no history splice)", async () => {
        const {store, wrapper, actions} = await makeHarness();
        act(() => { store.dispatch(enqueueMessage(outboxMsg("m1"))); });
        const {result} = renderHook(() => useOutboxStatus({selectedChatId: null, myId: MY}), {wrapper});
        act(() => { result.current.discardMessage("m1"); });
        expect(actions.some((a) => a.type === "outbox/discardMessage")).toBe(true);
    });
});
