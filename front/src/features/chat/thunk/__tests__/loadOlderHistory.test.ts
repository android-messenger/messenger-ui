import {describe, it, expect, vi, beforeEach} from "vitest";
import {loadOlderHistory} from "../loadOlderHistory";
import chatHistoryReducer, {answerTaken, selectRows, type ChatHistoryState} from "@/features/chat/model/slices/chatHistorySlice";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema";

vi.mock("@/shared/logger/logger", () => ({logger: {error: vi.fn(), debug: vi.fn(), warn: vi.fn()}}));

// Two valid ULIDs (26 chars, Crockford — chronological by lexicographic order).
const OLD_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NEW_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

const cacheRow = (id: string): ChatMessage => ({
    id, chatId: "c1", from: "u2", to: "me", text: "x", createdAt: new Date(0), status: "sent",
});
// A wire history row that parses (type) → wireToChatMessage (id = messageId).
const wireRow = (messageId: string, body: string) => ({
    type: "CHAT_OUT", messageId, conversationId: "c1", senderId: "u2", payload: {kind: "text", body},
});

// The thunk against the real chatHistory reducer: chat "c1" holds `data`, a dispatched action is applied.
function run(chatId: string, opts: {userId?: string; data?: ChatMessage[]}) {
    const {userId = "me", data = []} = opts;
    let chatHistory: ChatHistoryState = chatHistoryReducer(undefined, answerTaken({chatId: "c1", answer: data, whole: false, epoch: null}));
    const getState = () => ({user: {id: userId}, chatHistory});
    const dispatch = vi.fn((action: {type: string}) => {
        chatHistory = chatHistoryReducer(chatHistory, action);
        return action;
    });
    const rows = () => selectRows(getState(), "c1") ?? [];
    // @ts-expect-error minimal dispatch and getState for the thunk
    return {promise: loadOlderHistory(chatId)(dispatch, getState), dispatch, rows};
}

beforeEach(() => vi.clearAllMocks());

describe("loadOlderHistory", () => {
    // The thunk no longer needs my id (the rows are keyed by the chat alone), so "no myId" is not a case.
    it("returns 0 with no chatId, empty data, or no ULID cursor — and asks the server nothing", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        expect(await run("", {data: [cacheRow(OLD_ULID)]}).promise).toBe(0);
        expect(await run("c1", {data: []}).promise).toBe(0);
        expect(await run("c1", {data: [cacheRow("temp-client-id")]}).promise).toBe(0); // no ULID → no cursor
        expect(fetchMock).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it("uses the oldest ULID as the `before` cursor and fetches that page", async () => {
        const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>(async () => ({ok: true, json: async () => ({messages: []})}));
        vi.stubGlobal("fetch", fetchMock);
        await run("c1", {data: [cacheRow(OLD_ULID)]}).promise;
        const url = fetchMock.mock.calls[0][0] as string;
        expect(url).toContain(`before=${OLD_ULID}`);
        expect(url).toContain("limit=");
        expect(fetchMock.mock.calls[0][1]).toMatchObject({credentials: "include"});
        vi.unstubAllGlobals();
    });

    it("dedups fetched rows against the draft and prepends only the new ones (returns the added count)", async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({messages: [wireRow(NEW_ULID, "older"), wireRow(OLD_ULID, "dup")]}),
        }));
        vi.stubGlobal("fetch", fetchMock);
        const {promise, rows} = run("c1", {data: [cacheRow(OLD_ULID)]});
        const added = await promise;
        expect(added).toBe(1);                                   // OLD_ULID row deduped
        expect(rows()[0].id).toBe(NEW_ULID);                     // prepended (unshift)
        expect(rows()).toHaveLength(2);
        vi.unstubAllGlobals();
    });

    it("returns 0 on a non-ok response and on a fetch throw", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ok: false, json: async () => ({})})));
        expect(await run("c1", {data: [cacheRow(OLD_ULID)]}).promise).toBe(0);
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
        expect(await run("c1", {data: [cacheRow(OLD_ULID)]}).promise).toBe(0);
        vi.unstubAllGlobals();
    });

    it("returns 0 when the fetched page is empty", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ok: true, json: async () => ({messages: []})})));
        expect(await run("c1", {data: [cacheRow(OLD_ULID)]}).promise).toBe(0);
        vi.unstubAllGlobals();
    });
});
