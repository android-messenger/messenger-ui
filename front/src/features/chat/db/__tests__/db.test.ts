import "fake-indexeddb/auto";
import {describe, it, expect, beforeEach, vi} from "vitest";

// Shrink the media-cache budget so eviction is testable with tiny blobs.
vi.mock("@/shared/config/chat.ts", async (orig) => ({
    ...(await orig<typeof import("@/shared/config/chat.ts")>()),
    ATTACHMENT_CACHE_MAX_BYTES: 100,
}));

// The history cache must never reach the device key / Vault (F1 Т1.5) — spy on the wrap functions.
vi.mock("@/features/e2ee/lib/deviceKey.ts", async (orig) => ({
    ...(await orig<typeof import("@/features/e2ee/lib/deviceKey.ts")>()),
    wrapBytes: vi.fn(), unwrapBytes: vi.fn(),
}));

import {wrapBytes, unwrapBytes} from "@/features/e2ee/lib/deviceKey.ts";
import {
    saveOutboxToDB, loadOutboxFromDB,
    saveHistoryToDB, loadHistoryFromDB,
    saveAttachmentBlob, loadAttachmentBlob, deleteAttachmentBlob,
    deleteChatCache, historyChatIds, pruneAttachmentIndex,
    clearAllLocalData, initDB, scrubHistoryCache, isSecretRow, toDiskRows, mediaStats,
} from "../db";
import {HISTORY_STORE_NAME} from "@/shared/config/idb";
import type {OutboxState} from "@/features/chat/model/types";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema";

const blob = (bytes: number) => new Blob([new Uint8Array(bytes)]);

describe("db (IndexedDB via fake-indexeddb)", () => {
    beforeEach(async () => { await clearAllLocalData(); });

    it("round-trips the outbox", async () => {
        const state = {messages: [{id: "m1"}]} as unknown as OutboxState;
        await saveOutboxToDB(state);
        expect(await loadOutboxFromDB()).toEqual(state);
    });

    it("round-trips per-conversation history and returns null for an unknown chat", async () => {
        const msgs = [{id: "a"}, {id: "b"}] as unknown as ChatMessage[];
        await saveHistoryToDB("c1", msgs);
        expect(await loadHistoryFromDB("c1")).toEqual(msgs);
        expect(await loadHistoryFromDB("nope")).toBeNull();
    });

    it("round-trips an attachment blob and deletes it", async () => {
        await saveAttachmentBlob("att1", blob(10));
        expect(await loadAttachmentBlob("att1")).not.toBeNull();
        await deleteAttachmentBlob("att1");
        expect(await loadAttachmentBlob("att1")).toBeNull();
    });

    it("evicts the OLDEST attachment once the byte budget is exceeded", async () => {
        await saveAttachmentBlob("a", blob(40));
        await saveAttachmentBlob("b", blob(40)); // total 80 ≤ 100
        await saveAttachmentBlob("c", blob(40)); // total 120 > 100 → oldest "a" evicted
        expect(await loadAttachmentBlob("a")).toBeNull();
        expect(await loadAttachmentBlob("b")).not.toBeNull();
        expect(await loadAttachmentBlob("c")).not.toBeNull();
    });

    it("re-saving an id refreshes it as newest (not evicted next)", async () => {
        await saveAttachmentBlob("a", blob(40));
        await saveAttachmentBlob("b", blob(40));
        await saveAttachmentBlob("a", blob(40)); // touch "a" → order now [b, a]
        await saveAttachmentBlob("c", blob(40)); // evicts oldest "b"
        expect(await loadAttachmentBlob("b")).toBeNull();
        expect(await loadAttachmentBlob("a")).not.toBeNull();
        expect(await loadAttachmentBlob("c")).not.toBeNull();
    });

    it("deleteChatCache drops the history AND its attachment blobs — and keeps the index consistent", async () => {
        const msgs = [
            {id: "m1", meta: {attachmentId: "att1"}},
            {id: "m2"},
            {id: "m3", meta: {attachmentId: "att2"}},
        ] as unknown as ChatMessage[];
        await saveHistoryToDB("c1", msgs);
        await saveAttachmentBlob("att1", blob(10));
        await saveAttachmentBlob("att2", blob(10));

        await deleteChatCache("c1");

        expect(await loadHistoryFromDB("c1")).toBeNull();
        expect(await loadAttachmentBlob("att1")).toBeNull();
        expect(await loadAttachmentBlob("att2")).toBeNull();
        // Regression: the index entries were actually removed (the old code deleted by the wrong key shape
        // and leaked them), so there is nothing dangling left to prune.
        expect(await pruneAttachmentIndex()).toBe(0);
    });

    it("historyChatIds lists every cached conversation", async () => {
        await saveHistoryToDB("c1", [{id: "a"}] as unknown as ChatMessage[]);
        await saveHistoryToDB("c2", [{id: "b"}] as unknown as ChatMessage[]);
        expect((await historyChatIds()).sort()).toEqual(["c1", "c2"]);
    });

    it("clearAllLocalData wipes outbox, history and media", async () => {
        await saveOutboxToDB({messages: []} as unknown as OutboxState);
        await saveHistoryToDB("c1", [{id: "a"}] as unknown as ChatMessage[]);
        await saveAttachmentBlob("att1", blob(10));
        await clearAllLocalData();
        expect(await loadOutboxFromDB()).toBeNull();
        expect(await loadHistoryFromDB("c1")).toBeNull();
        expect(await loadAttachmentBlob("att1")).toBeNull();
    });

    // --- F1 work 1: secret (E2EE) rows never reach chatDB/history ---------------------------------
    describe("secret rows stay off disk", () => {
        const PLAINTEXT = "meet at the old bridge at nine";
        const plain = {id: "p1", text: "an ordinary message", meta: {attachmentId: "att1"}};
        const decrypted = {id: "s1", text: PLAINTEXT, secret: true};
        const envelope = {id: "s2", text: "E2EE1:Y2lwaGVydGV4dA=="};
        const mixed = [plain, decrypted, envelope] as unknown as ChatMessage[];
        /** The record exactly as it sits in the store, bypassing loadHistoryFromDB's own filter. */
        const raw = async (chatId: string) => (await initDB()).get(HISTORY_STORE_NAME, chatId);
        /** Write a record the way an earlier client version did — unfiltered. */
        const putRaw = async (chatId: string, rows: unknown) => (await initDB()).put(HISTORY_STORE_NAME, rows, chatId);

        it("isSecretRow: the secret flag or an E2EE1 envelope; an ordinary row is not secret", () => {
            expect(isSecretRow({secret: true, text: "x"})).toBe(true);
            expect(isSecretRow({text: "E2EE1:abc"})).toBe(true);
            expect(isSecretRow({secret: false, text: "about E2EE1: the format"})).toBe(false);
            expect(isSecretRow({text: "hello"})).toBe(false);
        });

        it("toDiskRows returns the same array when nothing is dropped", () => {
            const rows = [plain] as unknown as ChatMessage[];
            expect(toDiskRows(rows)).toBe(rows);
            expect(toDiskRows(mixed)).toEqual([plain]);
        });

        it("saveHistoryToDB stores only the ordinary rows — no plaintext, no envelope", async () => {
            await saveHistoryToDB("c1", mixed);
            const stored = await raw("c1");
            expect(stored).toEqual([plain]);
            expect(JSON.stringify(stored)).not.toContain(PLAINTEXT);
            expect(JSON.stringify(stored)).not.toContain("E2EE1:");
        });

        it("loadHistoryFromDB filters a record written by an earlier client version", async () => {
            await putRaw("c1", mixed);
            expect(await loadHistoryFromDB("c1")).toEqual([plain]);
        });

        it("scrubHistoryCache rewrites dirty records once, then writes nothing", async () => {
            await putRaw("dirty", mixed);
            await putRaw("clean", [plain]);
            await putRaw("odd", "not-an-array");
            expect(await scrubHistoryCache()).toBe(1);
            expect(await raw("dirty")).toEqual([plain]);
            expect(await raw("clean")).toEqual([plain]);
            expect(await raw("odd")).toBe("not-an-array");
            expect(await scrubHistoryCache()).toBe(0);
        });

        it("the history cache never calls the device-key wrap (no Vault, no bridge)", async () => {
            await saveHistoryToDB("c1", mixed);
            await loadHistoryFromDB("c1");
            await putRaw("c2", mixed);
            await scrubHistoryCache();
            expect(wrapBytes).not.toHaveBeenCalled();
            expect(unwrapBytes).not.toHaveBeenCalled();
        });

        it("scrubHistoryCache swallows a storage error", async () => {
            const db = await initDB();
            const spy = vi.spyOn(db, "transaction").mockImplementation(() => { throw new Error("boom"); });
            await expect(scrubHistoryCache()).resolves.toBe(0);
            spy.mockRestore();
        });

        it("deleteChatCache still finds attachment ids; the counters count what is on disk", async () => {
            await saveHistoryToDB("c1", mixed);
            await saveAttachmentBlob("att1", blob(10));
            expect(await mediaStats()).toMatchObject({chats: 1, messages: 1, files: 1});
            expect(await historyChatIds()).toEqual(["c1"]);
            await deleteChatCache("c1");
            expect(await loadAttachmentBlob("att1")).toBeNull();
            expect(await raw("c1")).toBeUndefined();
        });
    });
});
