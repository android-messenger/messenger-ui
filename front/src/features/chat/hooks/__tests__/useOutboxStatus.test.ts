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
import chatHistoryReducer, {answerTaken, selectRows} from "@/features/chat/model/slices/chatHistorySlice";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema";
import {flushOutbox} from "@/features/chat/thunk/sendOutboxThunk.ts";

const flush = vi.mocked(flushOutbox);
const MY = "me";

const row = (id: string): ChatMessage => ({
    id, chatId: "c1", from: MY, to: "peer", text: "x", createdAt: new Date(0), status: "sent",
});

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
        reducer: {outbox: outboxReducer, chatHistory: chatHistoryReducer},
        middleware: (gDM) => gDM({serializableCheck: false}).concat(recorder),
    });
    // The chat's rows, as if the server had answered with them.
    if (history) {
        store.dispatch(answerTaken({chatId: "c1", answer: history.map((m) => row(m.id)), whole: true, epoch: null}));
    }
    const wrapper = ({children}: {children: ReactNode}) => createElement(Provider, {store, children});
    return {store, wrapper, actions};
}

const historyIds = (store: Awaited<ReturnType<typeof makeHarness>>["store"]) =>
    (selectRows(store.getState(), "c1") ?? []).map((m) => m.id);

beforeEach(() => flush.mockClear());

describe("useOutboxStatus", () => {
    it("projects the outbox into an id→status map", async () => {
        const {store, wrapper} = await makeHarness();
        act(() => { store.dispatch(enqueueMessage(outboxMsg("m1"))); });
        const {result} = renderHook(() => useOutboxStatus({selectedChatId: "c1"}), {wrapper});
        expect(result.current.outboxStatusById["m1"]).toBe("pending");
    });

    it("retryMessage re-queues the message and flushes the outbox", async () => {
        const {store, wrapper, actions} = await makeHarness();
        act(() => { store.dispatch(enqueueMessage(outboxMsg("m1"))); });
        const {result} = renderHook(() => useOutboxStatus({selectedChatId: "c1"}), {wrapper});
        act(() => { result.current.retryMessage("m1"); });
        expect(actions.some((a) => a.type === "outbox/retryMessage")).toBe(true);
        expect(flush).toHaveBeenCalledTimes(1);
    });

    it("discardMessage drops the outbox entry AND splices the optimistic row out of the open history", async () => {
        const {store, wrapper, actions} = await makeHarness([{id: "m1"}, {id: "m2"}]);
        act(() => { store.dispatch(enqueueMessage(outboxMsg("m1"))); });
        const {result} = renderHook(() => useOutboxStatus({selectedChatId: "c1"}), {wrapper});
        act(() => { result.current.discardMessage("m1"); });
        expect(actions.some((a) => a.type === "outbox/discardMessage")).toBe(true);
        expect(historyIds(store)).toEqual(["m2"]); // optimistic m1 removed, m2 kept
    });

    it("discardMessage without an open chat still drops the outbox entry (no history splice)", async () => {
        const {store, wrapper, actions} = await makeHarness();
        act(() => { store.dispatch(enqueueMessage(outboxMsg("m1"))); });
        const {result} = renderHook(() => useOutboxStatus({selectedChatId: null}), {wrapper});
        act(() => { result.current.discardMessage("m1"); });
        expect(actions.some((a) => a.type === "outbox/discardMessage")).toBe(true);
    });
});
