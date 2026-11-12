import "fake-indexeddb/auto";
import {describe, it, expect, beforeEach, vi} from "vitest";

// The sweep must NEVER delete sealed secret plaintext (it's the only copy of your own sent messages).
// We still mock the e2ee surface so importing orphanGc stays in the chat-db realm (no libsignal), and we
// assert deletePlaintextForChat is never called.
vi.mock("@/features/e2ee", () => ({
    plaintextChatIds: vi.fn(async () => ["c-live", "c-orphan", "c-secret-only"]),
    deletePlaintextForChat: vi.fn(async () => {}),
}));

import {reconcileOrphanCaches} from "../orphanGc";
import {deletePlaintextForChat} from "@/features/e2ee";
import {
    saveHistoryToDB, loadHistoryFromDB,
    saveAttachmentBlob, loadAttachmentBlob, clearAllLocalData,
} from "../db";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema";

const blob = (n: number) => new Blob([new Uint8Array(n)]);

describe("reconcileOrphanCaches", () => {
    beforeEach(async () => {
        await clearAllLocalData();
        vi.mocked(deletePlaintextForChat).mockClear();
    });

    it("purges cached history + blobs for chats not in the live set, keeps the rest", async () => {
        await saveHistoryToDB("c-live", [{id: "a"}] as unknown as ChatMessage[]);
        await saveHistoryToDB("c-orphan", [{id: "b", meta: {attachmentId: "att-orphan"}}] as unknown as ChatMessage[]);
        await saveAttachmentBlob("att-orphan", blob(20));

        const res = await reconcileOrphanCaches(new Set(["c-live"]));

        // History: the orphan is gone, the live one stays; its attachment blob is gone too.
        expect(await loadHistoryFromDB("c-orphan")).toBeNull();
        expect(await loadHistoryFromDB("c-live")).not.toBeNull();
        expect(await loadAttachmentBlob("att-orphan")).toBeNull();
        expect(res).toMatchObject({chats: 1});
    });

    it("NEVER deletes sealed secret plaintext (unrecoverable own-message copies), even for orphans", async () => {
        await saveHistoryToDB("c-orphan", [{id: "b"}] as unknown as ChatMessage[]);
        await reconcileOrphanCaches(new Set(["c-live"]));   // c-orphan absent
        // The false-positive-prone "absent from list" signal must not destroy sealed plaintext.
        expect(deletePlaintextForChat).not.toHaveBeenCalled();
    });

    it("an empty live set (successful load, no chats) purges the re-fetchable caches", async () => {
        await saveHistoryToDB("c1", [{id: "a"}] as unknown as ChatMessage[]);
        await saveHistoryToDB("c2", [{id: "b"}] as unknown as ChatMessage[]);
        const res = await reconcileOrphanCaches(new Set());
        expect(await loadHistoryFromDB("c1")).toBeNull();
        expect(await loadHistoryFromDB("c2")).toBeNull();
        expect(res.chats).toBe(2);
        expect(deletePlaintextForChat).not.toHaveBeenCalled();
    });

    it("keeps everything when all chats are live (no-op)", async () => {
        await saveHistoryToDB("c-live", [{id: "a"}] as unknown as ChatMessage[]);
        const res = await reconcileOrphanCaches(new Set(["c-live", "c-orphan", "c-secret-only"]));
        expect(await loadHistoryFromDB("c-live")).not.toBeNull();
        expect(res).toMatchObject({chats: 0});
    });
});
