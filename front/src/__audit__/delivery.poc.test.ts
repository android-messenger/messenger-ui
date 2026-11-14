import "fake-indexeddb/auto";
import {describe, it, expect, beforeEach, afterEach, vi} from "vitest";
import {configureStore, type Middleware} from "@reduxjs/toolkit";

// Audit 2026-11-14 (specs/002-reliable-delivery/audit.md). The REAL chatApi, chatMiddleware and slices in a
// real store; only the network (fetch) and the socket (ws/incoming actions) are played by the test.
// Every test here states the behaviour AS IT IS NOW — a defect. When a defect is fixed, its test is turned over.

vi.mock("@/shared/config/api.ts", async (orig) => ({
    ...(await orig<typeof import("@/shared/config/api.ts")>()),
    MESSENGER_API: "http://edge.test/messenger/api",
}));
vi.mock("@/shared/i18n", () => ({default: {t: (k: string) => k}}));
vi.mock("@/shared/sound/notify.ts", () => ({playNotificationSound: vi.fn()}));
vi.mock("react-hot-toast", () => ({default: {error: vi.fn(), success: vi.fn()}}));

import {chatApi} from "@/features/chat/rest/chatApi";
import "@/features/groups/rest/groupApi";
import {chatMiddleware} from "@/features/chat/middleware/chatMiddleware";
import {authErrorListener} from "@/features/auth/middleware/authErrorMiddleware";
import userReducer, {setUser} from "@/features/auth/slices/userSlice";
import wsReducer, {connected, incoming} from "@/infrastructure/slices/websocketSlice";
import chatUiReducer from "@/features/chat/model/slices/chatUiSlice";
import outboxReducer, {enqueueMessage} from "@/features/chat/model/slices/outboxSlice";
import secretChatsReducer from "@/features/chat/model/slices/secretChatsSlice";
import {toOutboxMessage} from "@/features/chat/model/mapper";
import {chatMessagesService} from "@/features/chat/model/services/chatMessages.service";
import {forgetHistorySync, isStale} from "@/features/chat/model/historySync";
import {clearAllLocalData, saveHistoryToDB} from "@/features/chat/db/db";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema";

const MY = "me";
const PEER = "peer";
const CHAT = "c1";
const M1 = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const M2 = "01ARZ3NDEKTSV4RRFFQ69G5FA2";

const row = (messageId: string, senderId: string, body: string) => ({
    type: "CHAT_OUT", messageId, conversationId: CHAT, senderId, recipientId: senderId === MY ? PEER : MY,
    serverTimestamp: 1_700_000_000_000, payload: {kind: "text", body},
});
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json"}});

/** The history endpoint answers what the test hands out, one answer per request, when the test says so. */
function network() {
    const waiting: Array<(r: Response | Error) => void> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes(`/chats/${CHAT}/messages`)) {
            return new Promise<Response>((resolve, reject) => {
                waiting.push((r) => (r instanceof Error ? reject(r) : resolve(r)));
            });
        }
        return Promise.resolve(json([]));   // chat list, groups
    });
    vi.stubGlobal("fetch", fetchMock);
    return {
        fetchMock,
        requests: () => fetchMock.mock.calls.filter(([i]) => (i instanceof Request ? i.url : String(i)).includes("/messages")).length,
        async answer(r: Response | Error) {
            for (let i = 0; i < 200 && waiting.length === 0; i++) await new Promise((res) => setTimeout(res, 5));
            waiting.shift()!(r);
        },
    };
}

function makeStore() {
    const sent: Array<Record<string, unknown>> = [];
    const socket: Middleware = () => (next) => (action) => {
        const a = action as {type?: string; payload?: Record<string, unknown>};
        if (a?.type === "ws/send" && a.payload) sent.push(a.payload);
        return next(action);
    };
    const store = configureStore({
        reducer: {
            user: userReducer, ws: wsReducer, chatUi: chatUiReducer, outbox: outboxReducer,
            secretChats: secretChatsReducer, [chatApi.reducerPath]: chatApi.reducer,
        },
        middleware: (gDM) => gDM({serializableCheck: false, immutableCheck: false})
            .prepend(authErrorListener.middleware).concat(chatApi.middleware, socket, chatMiddleware),
    });
    store.dispatch(setUser({id: MY, name: "Me"}));
    return {store, sent};
}

type Store = ReturnType<typeof makeStore>["store"];
const history = (store: Store) => chatApi.endpoints.getChatHistory.select({myId: MY, chatId: CHAT})(store.getState() as never);
const ids = (store: Store) => history(store).data?.map((m) => m.id);
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("audit 002: where a message can be lost from the screen or from the queue", () => {
    let net: ReturnType<typeof network>;
    beforeEach(async () => {
        await clearAllLocalData();
        forgetHistorySync();
        net = network();
    });
    afterEach(() => vi.unstubAllGlobals());

    it("A1: a message that comes over the socket while the history is read again is acknowledged, then wiped by the answer — and the chat counts as complete", async () => {
        const {store, sent} = makeStore();
        store.dispatch(connected());
        const sub = store.dispatch(chatApi.endpoints.getChatHistory.initiate({myId: MY, chatId: CHAT}));
        await net.answer(json({messages: [row(M1, PEER, "first")]}));
        await sub;
        expect(ids(store)).toEqual([M1]);

        // The chat is read again (return to the screen, an attachment was sent, "retry"). The server reads its
        // table, and only then stores and delivers the next message: the answer on its way does not hold it.
        const reread = store.dispatch(chatApi.endpoints.getChatHistory.initiate({myId: MY, chatId: CHAT}, {forceRefetch: true, subscribe: false}));
        store.dispatch(incoming(row(M2, PEER, "second")));
        expect(ids(store)).toEqual([M1, M2]);                                   // shown for a moment
        expect(sent.some((f) => f.type === "CHAT_ACK")).toBe(true);             // the server will not send it again

        await net.answer(json({messages: [row(M1, PEER, "first")]}));
        await reread;
        expect(ids(store)).toEqual([M1]);                                       // DEFECT: the message is gone from the screen
        expect(isStale(CHAT, store.getState().ws)).toBe(false);                 // DEFECT: nothing will read the chat again
        await settle();
        expect(net.requests()).toBe(2);
        sub.unsubscribe();
    });

    it("A2: the same while the chat is read for the first time — the message is acknowledged and never shown", async () => {
        const {store, sent} = makeStore();
        store.dispatch(connected());
        const sub = store.dispatch(chatApi.endpoints.getChatHistory.initiate({myId: MY, chatId: CHAT}));
        store.dispatch(incoming(row(M2, PEER, "second")));
        expect(sent.some((f) => f.type === "CHAT_ACK")).toBe(true);
        await net.answer(json({messages: [row(M1, PEER, "first")]}));
        await sub;
        expect(ids(store)).toEqual([M1]);                                       // DEFECT
        expect(isStale(CHAT, store.getState().ws)).toBe(false);                 // DEFECT
        sub.unsubscribe();
    });

    it("A3: a 401 on any request empties the send queue — the unsent messages are gone", async () => {
        const {store} = makeStore();
        store.dispatch(enqueueMessage(toOutboxMessage({conversationId: CHAT, recipientId: PEER, text: "not sent yet"})));
        expect(store.getState().outbox.messages).toHaveLength(1);
        vi.stubGlobal("fetch", vi.fn(async () => json({error: "unauthorized"}, 401)));
        await store.dispatch(chatApi.endpoints.getChats.initiate({myId: MY}, {subscribe: false}));
        await settle();
        expect(store.getState().outbox.messages).toHaveLength(0);               // DEFECT: the same user signs in again to an empty queue
    });

    it("A4: a queued message whose text I have sent before disappears from the chat when the history is read", async () => {
        const {store} = makeStore();
        store.dispatch(connected());
        const queued = toOutboxMessage({conversationId: CHAT, recipientId: PEER, text: "ok"});
        store.dispatch(enqueueMessage(queued));
        const sub = store.dispatch(chatApi.endpoints.getChatHistory.initiate({myId: MY, chatId: CHAT}));
        await net.answer(json({messages: [row(M1, MY, "ok")]}));               // yesterday's "ok", delivered long ago
        await sub;
        expect(store.getState().outbox.messages.map((m) => m.id)).toEqual([queued.id]);   // still to be sent
        expect(ids(store)).toEqual([M1]);                                       // DEFECT: and not on the screen
        sub.unsubscribe();
    });

    it("A5: in a chat whose history could not be read, my new message is queued but not shown", async () => {
        const {store} = makeStore();
        const sub = store.dispatch(chatApi.endpoints.getChatHistory.initiate({myId: MY, chatId: CHAT}));
        await net.answer(new TypeError("Failed to fetch"));
        await sub;
        expect(history(store).isError).toBe(true);
        await chatMessagesService.enqueueChatMessage(store.dispatch as never, "hello", MY, CHAT, PEER);
        expect(store.getState().outbox.messages).toHaveLength(1);
        expect(history(store).data).toBeUndefined();                           // DEFECT: no bubble with the clock
        sub.unsubscribe();
    });

    it("A6: the history stored on the device is not shown while the first read is on its way, nor after it failed", async () => {
        await saveHistoryToDB(CHAT, [{id: M1, chatId: CHAT, from: PEER, to: MY, text: "cached", createdAt: new Date(), status: "sent"}] as ChatMessage[]);
        const {store} = makeStore();
        const sub = store.dispatch(chatApi.endpoints.getChatHistory.initiate({myId: MY, chatId: CHAT}));
        await settle();
        expect(history(store).data).toBeUndefined();                           // DEFECT: the cache was read and dropped
        await net.answer(new TypeError("Failed to fetch"));
        await sub;
        await settle();
        expect(history(store).data).toBeUndefined();                           // DEFECT: offline the chat is empty
        sub.unsubscribe();
    });
});
