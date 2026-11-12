import "fake-indexeddb/auto";
import {describe, it, expect, beforeEach, afterEach, vi} from "vitest";
import {configureStore} from "@reduxjs/toolkit";

// Node's Request rejects host-relative URLs, so give the api an absolute base for this test.
vi.mock("@/shared/config/api.ts", async (orig) => ({
    ...(await orig<typeof import("@/shared/config/api.ts")>()),
    MESSENGER_API: "http://edge.test/messenger/api",
}));

import {chatApi} from "../chatApi";
import {initDB, clearAllLocalData} from "@/features/chat/db/db";
import {HISTORY_STORE_NAME} from "@/shared/config/idb";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema";

// Finding № 1 (F1, work 1): the real chatApi against a real Redux store and IndexedDB. After a secret
// message is decrypted in memory, deleting ANY message used to write the whole in-memory array —
// decrypted text included — into chatDB/history.

const MY = "me";
const CHAT = "c1";
const PLAIN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const SECRET_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
const MINE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA3";
const SECRET_TEXT = "meet at the old bridge at nine";

const wireRow = (messageId: string, senderId: string, body: string) => ({
    type: "CHAT_OUT", messageId, conversationId: CHAT, senderId, payload: {kind: "text", body},
});

function makeStore() {
    return configureStore({
        reducer: {
            user: (s: {id: string} = {id: MY}) => s,
            chatUi: (s: object = {}) => s,
            outbox: (s: {messages: unknown[]} = {messages: []}) => s,
            [chatApi.reducerPath]: chatApi.reducer,
        },
        middleware: (gDM) => gDM({serializableCheck: false, immutableCheck: false}).concat(chatApi.middleware),
    });
}

const json = (body: unknown) => new Response(JSON.stringify(body), {status: 200, headers: {"Content-Type": "application/json"}});

async function storedHistory(): Promise<ChatMessage[] | undefined> {
    const db = await initDB();
    return (await db.get(HISTORY_STORE_NAME, CHAT)) as ChatMessage[] | undefined;
}

/** Wait until the history record has been (re)written `n` times. */
async function waitFor(check: () => Promise<boolean>) {
    for (let i = 0; i < 200; i++) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("condition not reached");
}

describe("chatApi history cache — secret rows never reach chatDB/history", () => {
    beforeEach(async () => {
        await clearAllLocalData();
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const method = (input instanceof Request ? input.method : init?.method) ?? "GET";
            if (method === "DELETE") return json({});
            return json({
                messages: [
                    wireRow(PLAIN_ID, "peer", "an ordinary message"),
                    wireRow(SECRET_ID, "peer", "E2EE1:Y2lwaGVydGV4dA=="),
                    wireRow(MINE_ID, MY, "my ordinary message"),
                ],
            });
        }));
    });
    afterEach(() => vi.unstubAllGlobals());

    it("deleteMessage in a chat with decrypted secret messages writes no secret row and no plaintext", async () => {
        const store = makeStore();
        const sub = store.dispatch(chatApi.endpoints.getChatHistory.initiate({myId: MY, chatId: CHAT}));
        await sub;
        await waitFor(async () => (await storedHistory()) !== undefined);

        // What chatMiddleware does once the envelope is decrypted: plaintext + secret flag, in memory.
        store.dispatch(chatApi.util.updateQueryData("getChatHistory", {myId: MY, chatId: CHAT}, (draft) => {
            const row = draft.find((m) => m.id === SECRET_ID);
            if (row) { row.text = SECRET_TEXT; row.secret = true; }
        }));

        await store.dispatch(chatApi.endpoints.deleteMessage.initiate({chatId: CHAT, backendId: MINE_ID})).unwrap();
        await waitFor(async () => !(await storedHistory())?.some((m) => m.id === MINE_ID));

        const stored = await storedHistory();
        expect(JSON.stringify(stored)).not.toContain(SECRET_TEXT);
        expect(stored?.some((m) => m.secret === true)).toBe(false);
        expect(stored?.some((m) => m.text.startsWith("E2EE1:"))).toBe(false);
        expect(stored?.map((m) => m.id)).toEqual([PLAIN_ID]);   // ordinary rows are still cached
        sub.unsubscribe();
    });

    it("the first load does not cache the envelope either", async () => {
        const store = makeStore();
        const sub = store.dispatch(chatApi.endpoints.getChatHistory.initiate({myId: MY, chatId: CHAT}));
        await sub;
        await waitFor(async () => (await storedHistory()) !== undefined);
        expect((await storedHistory())?.map((m) => m.id)).toEqual([PLAIN_ID, MINE_ID]);
        sub.unsubscribe();
    });
});
