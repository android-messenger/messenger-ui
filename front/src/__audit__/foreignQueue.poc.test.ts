import "fake-indexeddb/auto";
import {describe, it, expect, vi} from "vitest";
import type {WebRTCService} from "@/features/call/service/webRTCService.ts";
import {toOutboxMessage} from "@/features/chat/model/mapper";

// Audit 2026-11-14 (specs/002-reliable-delivery/audit.md), finding 9. States the behaviour AS IT IS NOW.
// The send queue is read from disk at the start, before anyone knows whose session this is. When the owner
// check then finds another account (RequireAuth → dropForeignCache), the disk is erased — the queue in
// memory is not, and it is sent under the new account as soon as the socket connects.

const webrtc = {setSendCallback: () => {}, setEventCallbacks: () => {}} as unknown as WebRTCService;

describe("audit 002: the queue of the previous account", () => {
    it("A7: stays in memory after the cache of another account was dropped", async () => {
        const db = await import("@/features/chat/db/db");
        const theirs = toOutboxMessage({conversationId: "c-theirs", recipientId: "their-peer", text: "written by the previous account"});
        await db.saveOutboxToDB({messages: [theirs], outboxVersion: 1, persistedVersion: 1});

        vi.resetModules();
        const {configureAppStore, hydrateStore, dropForeignCache} = await import("@/store/store");
        const store = configureAppStore(webrtc);
        await hydrateStore(store);
        expect(store.getState().outbox.messages).toHaveLength(1);

        await store.dispatch(dropForeignCache());
        expect(store.getState().outbox.messages.map((m) => m.id)).toEqual([theirs.id]);   // DEFECT: still queued, will be sent
        await new Promise((r) => setTimeout(r, 600));   // the store's debounced save
    });
});
