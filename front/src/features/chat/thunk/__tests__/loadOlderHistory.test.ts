import {describe, it, expect, vi, beforeEach, type Mock} from "vitest";
import {loadOlderHistory} from "../loadOlderHistory";
import {chatApi} from "@/features/chat/rest/chatApi";

vi.mock("@/features/chat/rest/chatApi", () => ({
    chatApi: {
        endpoints: {getChatHistory: {select: vi.fn()}},
        util: {updateQueryData: vi.fn()},
    },
}));
vi.mock("@/shared/logger/logger", () => ({logger: {error: vi.fn(), debug: vi.fn(), warn: vi.fn()}}));

// Two valid ULIDs (26 chars, Crockford — chronological by lexicographic order).
const OLD_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NEW_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

const select = chatApi.endpoints.getChatHistory.select as unknown as Mock;
const updateQueryData = chatApi.util.updateQueryData as unknown as Mock;

const cacheRow = (id: string) => ({
    id, chatId: "c1", from: "u2", to: "me", text: "x", createdAt: new Date(0), status: "sent",
});
// A wire history row that parses (type) → wireToChatMessage (id = messageId).
const wireRow = (messageId: string, body: string) => ({
    type: "CHAT_OUT", messageId, conversationId: "c1", senderId: "u2", payload: {kind: "text", body},
});

function run(chatId: string, opts: {userId?: string; data?: unknown[]; draft?: unknown[]}) {
    const {userId = "me", data = [], draft = data} = opts;
    const getState = () => ({user: {id: userId}});
    select.mockReturnValue(() => ({data}));
    // Run the recipe against the draft synchronously so `added` is computed (mirrors dispatch applying it).
    updateQueryData.mockImplementation((_ep: string, _args: unknown, recipe: (d: unknown[]) => void) => {
        recipe(draft);
        return {type: "chatApi/updateQueryData"};
    });
    const dispatch = vi.fn();
    // @ts-expect-error minimal getState for the thunk
    return {promise: loadOlderHistory(chatId)(dispatch, getState), dispatch, draft};
}

beforeEach(() => vi.clearAllMocks());

describe("loadOlderHistory", () => {
    it("returns 0 with no myId, no chatId, empty data, or no ULID cursor", async () => {
        expect(await run("c1", {userId: "", data: [cacheRow(OLD_ULID)]}).promise).toBe(0);
        expect(await run("", {data: [cacheRow(OLD_ULID)]}).promise).toBe(0);
        expect(await run("c1", {data: []}).promise).toBe(0);
        expect(await run("c1", {data: [cacheRow("temp-client-id")]}).promise).toBe(0); // no ULID → no cursor
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
        const draft = [cacheRow(OLD_ULID)];
        const added = await run("c1", {data: draft, draft}).promise;
        expect(added).toBe(1);                                   // OLD_ULID row deduped
        expect((draft[0] as {id: string}).id).toBe(NEW_ULID);    // prepended (unshift)
        expect(draft).toHaveLength(2);
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
