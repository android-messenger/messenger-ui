import "fake-indexeddb/auto";
import {describe, it, expect, beforeEach, afterEach, vi} from "vitest";
import {installFakeApp} from "@/features/e2ee/lib/__tests__/fakeApp.ts";
import {abortVaultWaits} from "@/features/e2ee/lib/deviceKey.ts";
import type {WebRTCService} from "@/features/call/service/webRTCService.ts";
import type {OutboxState} from "@/features/chat/model/types";

// Plan F6, stage 5: in the Android app the lists of chats, the drafts and the send queue are sealed
// records, read after the start. What an earlier build kept in localStorage moves there once.

const webrtc = {setSendCallback: () => {}, setEventCallbacks: () => {}} as unknown as WebRTCService;
const queued = (id: string) => ({id, idempotencyKey: id, payload: {}, status: "pending", attempts: 0});

async function start() {
    vi.resetModules();
    const {configureAppStore, hydrateStore} = await import("@/store/store");
    const db = await import("@/features/chat/db/db");
    const drafts = await import("@/features/chat/model/drafts");
    const secret = await import("@/features/chat/model/slices/secretChatsSlice");
    const outbox = await import("@/features/chat/model/slices/outboxSlice");
    return {configureAppStore, hydrateStore, db, drafts, secret, outbox};
}

describe("startup restore of the sealed lists (Android app)", () => {
    let app: ReturnType<typeof installFakeApp>;
    beforeEach(async () => {
        app = installFakeApp();
        localStorage.clear();
        await (await start()).db.clearAllLocalData();
    });
    afterEach(() => { abortVaultWaits(); app.uninstall(); });

    it("moves what an earlier build kept in localStorage into sealed records, keeping what changed meanwhile", {timeout: 20_000}, async () => {
        localStorage.setItem("wolp.secretChats", JSON.stringify({"c-old": true, "c-off": false}));
        localStorage.setItem("wolp.sticky-chats.v1", JSON.stringify({"c-sticky": {conversationId: "c-sticky", kind: "direct"}}));
        localStorage.setItem("wolp.drafts.v1", JSON.stringify({"c-plain": "half a sentence", "c-old": "typed before it became secret"}));
        const m = await start();
        await m.db.saveOutboxToDB({messages: [queued("stored")], outboxVersion: 1, persistedVersion: 1} as unknown as OutboxState);

        const store = m.configureAppStore(webrtc);
        expect(store.getState().secretChats.byId).toEqual({});          // nothing is read from localStorage in the app
        store.dispatch(m.secret.markSecret("c-new"));                    // before the restore
        store.dispatch(m.outbox.enqueueMessage(queued("fresh") as never));
        await m.hydrateStore(store);                                    // does not wait for the restore

        await vi.waitFor(() => expect(store.getState().secretChats.byId).toEqual({"c-old": true, "c-off": false, "c-new": true}), {timeout: 5000});
        expect(Object.keys(store.getState().stickyChats.byId)).toEqual(["c-sticky"]);
        expect(store.getState().outbox.messages.map((x) => x.id)).toEqual(["stored", "fresh"]);
        expect(m.drafts.loadDraft("c-plain")).toBe("half a sentence");
        expect(m.drafts.loadDraft("c-old")).toBe("typed before it became secret");   // in memory only now

        for (const k of ["wolp.secretChats", "wolp.sticky-chats.v1", "wolp.drafts.v1"]) expect(localStorage.getItem(k)).toBeNull();
        await vi.waitFor(async () => {
            expect(await m.db.kvGet(m.db.KV.secretChats)).toEqual({"c-old": true, "c-off": false, "c-new": true});
            expect(await m.db.kvGet(m.db.KV.stickyChats)).toHaveProperty("c-sticky");
            expect(await m.db.kvGet(m.db.KV.drafts)).toEqual({"c-plain": "half a sentence"});   // a secret chat's draft is not stored
            expect((await m.db.loadOutboxFromDB())?.messages.map((x) => x.id)).toEqual(["stored", "fresh"]);
        }, {timeout: 5000});

        // the next start reads the sealed records
        const n = await start();
        const next = n.configureAppStore(webrtc);
        await n.hydrateStore(next);
        await vi.waitFor(() => expect(next.getState().secretChats.byId).toEqual({"c-old": true, "c-off": false, "c-new": true}), {timeout: 5000});
        expect(n.drafts.loadDraft("c-plain")).toBe("half a sentence");
        expect(next.getState().outbox.messages.map((x) => x.id)).toEqual(["stored", "fresh"]);
    });

    it("a locked phone does not hold up the start, and nothing stored is replaced while it is locked", async () => {
        const m = await start();
        await m.db.kvSet(m.db.KV.secretChats, {"c-old": true});
        const n = await start();
        let locked = true;
        const unwrap = app.plugin.vaultUnwrap.getMockImplementation()!;
        app.plugin.vaultUnwrap.mockImplementation(async (o) => {
            if (locked) throw Object.assign(new Error("locked"), {code: "VAULT_LOCKED"});
            return unwrap(o);
        });
        const store = n.configureAppStore(webrtc);
        await n.hydrateStore(store);                      // returns although the Vault is closed
        store.dispatch(n.secret.markSecret("c-new"));
        expect(store.getState().secretChats.byId).toEqual({"c-new": true});

        locked = false;
        await vi.waitFor(() => expect(store.getState().secretChats.byId).toEqual({"c-old": true, "c-new": true}), {timeout: 6000, interval: 200});
        await vi.waitFor(async () => expect(await n.db.kvGet(n.db.KV.secretChats)).toEqual({"c-old": true, "c-new": true}), {timeout: 3000});
    }, 12_000);
});
