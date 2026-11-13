import "fake-indexeddb/auto";
import {describe, it, expect, beforeEach, afterEach, vi} from "vitest";
import {installFakeApp} from "@/features/e2ee/lib/__tests__/fakeApp.ts";
import {abortVaultWaits} from "@/features/e2ee/lib/deviceKey.ts";
import type {WebRTCService} from "@/features/call/service/webRTCService.ts";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema";
import {ATTACHMENT_BLOB_STORE, HISTORY_STORE_NAME} from "@/shared/config/idb";

// Audit 2026-11-13, apps-delta: the auditor's tests against messenger-ui 2a3530d (F6 stage 5, sealed cache).
// Every test now asserts the FIXED behaviour (tasks T100–T112): before the fixes each showed the defect.

const webrtc = {setSendCallback: () => {}, setEventCallbacks: () => {}} as unknown as WebRTCService;
const SECRET_TEXT = "meet at the usual place at nine";

async function start() {
    vi.resetModules();
    const {configureAppStore, hydrateStore, dropForeignCache} = await import("@/store/store");
    const db = await import("@/features/chat/db/db");
    const drafts = await import("@/features/chat/model/drafts");
    const secret = await import("@/features/chat/model/slices/secretChatsSlice");
    const svc = await import("@/features/chat/model/services/chatMessages.service.ts");
    const lists = await import("@/features/chat/model/sealedLists.ts");
    return {configureAppStore, hydrateStore, dropForeignCache, db, drafts, secret, svc, lists};
}

describe("apps-delta PoC", () => {
    let app: ReturnType<typeof installFakeApp>;
    let encrypt: ReturnType<typeof vi.fn>;
    beforeEach(async () => {
        app = installFakeApp();
        encrypt = vi.fn(async () => ({envelope: "\u0001e2ee:ENVELOPE"}));
        (app.plugin as Record<string, unknown>).e2eeEncrypt = encrypt;
        localStorage.clear();
        await (await start()).db.clearAllLocalData();
    });
    afterEach(async () => {
        // The store of a test saves its queue 400 ms after the last change: let that write land before the
        // next test clears the disk, or it shows up there.
        await new Promise((r) => setTimeout(r, 600));
        abortVaultWaits(); app.uninstall();
    });

    // ---- F1 (fixed, T101–T105): nothing is sent until the list of secret chats is read ----
    // Before the fix the message typed into a secret chat was queued in the clear in all three cases.
    const failing = (code: string) => async () => { throw Object.assign(new Error(code), {code}); };

    for (const [name, code] of [["the Vault is closed (RASP pass not finished / gate closed)", "VAULT_LOCKED"], ["the bridge answers UNAVAILABLE", "UNAVAILABLE"]] as const) {
        it(`F1: a send is refused while ${name}; once the Vault opens the chat is secret again`, async () => {
            const m = await start();
            await m.db.kvSet(m.db.KV.secretChats, {"c-secret": true});       // the user turned secret mode on earlier

            const n = await start();                                          // cold start
            const real = app.plugin.vaultUnwrap.getMockImplementation()!;
            app.plugin.vaultUnwrap.mockImplementation(failing(code));
            const store = n.configureAppStore(webrtc);
            await n.hydrateStore(store);
            await new Promise((r) => setTimeout(r, 300));

            const secret = !!store.getState().secretChats.byId["c-secret"];
            expect(secret).toBe(false);                                       // the mark is still not known
            expect(n.lists.listsReady()).toBe(false);                         // and the app knows it does not know

            await n.svc.chatMessagesService.enqueueChatMessage(store.dispatch, SECRET_TEXT, "me", "c-secret", "peer", undefined, secret);
            expect(store.getState().outbox.messages).toHaveLength(0);         // refused: nothing queued
            expect(encrypt).not.toHaveBeenCalled();

            app.plugin.vaultUnwrap.mockImplementation(real);                  // the Vault opens
            await vi.waitFor(() => expect(store.getState().secretChats.byId["c-secret"]).toBe(true), {timeout: 6000, interval: 100});
            expect(n.lists.listsReady()).toBe(true);
            await n.svc.chatMessagesService.enqueueChatMessage(store.dispatch, SECRET_TEXT, "me", "c-secret", "peer", undefined, true);
            const queued = store.getState().outbox.messages;
            expect(queued).toHaveLength(1);
            expect(JSON.stringify(queued[0].payload)).not.toContain(SECRET_TEXT);
            expect(encrypt).toHaveBeenCalledTimes(1);
        }, 15_000);
    }

    // T104, owner's decision 2026-11-13: the key is lost for good — every chat is not secret, sending is open.
    it("F1: the Vault key is gone — the list is empty, a send is not refused, the old record is replaced on the next change", async () => {
        const m = await start();
        await m.db.kvSet(m.db.KV.secretChats, {"c-secret": true});

        const n = await start();
        const real = app.plugin.vaultUnwrap.getMockImplementation()!;
        app.plugin.vaultUnwrap.mockImplementation(failing("VAULT_KEY_GONE"));
        const store = n.configureAppStore(webrtc);
        await n.hydrateStore(store);
        await vi.waitFor(() => expect(n.lists.listsReady()).toBe(true), {timeout: 3000});
        expect(store.getState().secretChats.byId).toEqual({});

        await n.svc.chatMessagesService.enqueueChatMessage(store.dispatch, SECRET_TEXT, "me", "c-secret", "peer", undefined, false);
        expect(store.getState().outbox.messages).toHaveLength(1);

        app.plugin.vaultUnwrap.mockImplementation(real);                      // a new key: new records open
        store.dispatch(n.secret.markSecret("c-new"));
        await vi.waitFor(async () => expect(await n.db.kvGet(n.db.KV.secretChats)).toEqual({"c-new": true}), {timeout: 3000});
    }, 10_000);

    it("F1 control: with the Vault open the same chat is secret and the text is encrypted", async () => {
        const m = await start();
        await m.db.kvSet(m.db.KV.secretChats, {"c-secret": true});
        const n = await start();
        const store = n.configureAppStore(webrtc);
        await n.hydrateStore(store);
        await vi.waitFor(() => expect(store.getState().secretChats.byId["c-secret"]).toBe(true), {timeout: 3000});
        await n.svc.chatMessagesService.enqueueChatMessage(store.dispatch, SECRET_TEXT, "me", "c-secret", "peer", undefined, true);
        const queued = store.getState().outbox.messages;
        expect(queued).toHaveLength(1);
        expect(JSON.stringify(queued[0].payload)).not.toContain(SECRET_TEXT);
        expect(encrypt).toHaveBeenCalledTimes(1);
    }, 10_000);

    // ---- F1b (fixed, T103): a read that did not succeed does not let the stored lists be replaced ----
    it("F1b: after an unreadable start (UNAVAILABLE) a change made meanwhile is merged into the stored list, not written over it", async () => {
        const m = await start();
        await m.db.kvSet(m.db.KV.secretChats, {"c-a": true, "c-b": true});
        await m.db.saveOutboxToDB({messages: [{id: "stored", idempotencyKey: "stored", payload: {}, status: "pending", attempts: 0}], outboxVersion: 1, persistedVersion: 1} as never);

        const n = await start();
        const real = app.plugin.vaultUnwrap.getMockImplementation()!;
        app.plugin.vaultUnwrap.mockImplementation(failing("UNAVAILABLE"));
        const store = n.configureAppStore(webrtc);
        await n.hydrateStore(store);
        await new Promise((r) => setTimeout(r, 300));
        store.dispatch(n.secret.markSecret("c-new"));                          // e.g. a secret message arrived
        await new Promise((r) => setTimeout(r, 600));
        app.plugin.vaultUnwrap.mockImplementation(real);                       // the Vault works again
        expect(await n.db.kvGet(n.db.KV.secretChats)).toEqual({"c-a": true, "c-b": true});   // untouched meanwhile
        expect((await n.db.loadOutboxFromDB())?.messages.map((x) => x.id)).toEqual(["stored"]);

        await vi.waitFor(() => expect(store.getState().secretChats.byId).toEqual({"c-a": true, "c-b": true, "c-new": true}), {timeout: 6000, interval: 100});
        await vi.waitFor(async () => expect(await n.db.kvGet(n.db.KV.secretChats)).toEqual({"c-a": true, "c-b": true, "c-new": true}), {timeout: 3000});
        expect(store.getState().outbox.messages.map((x) => x.id)).toEqual(["stored"]);
    }, 15_000);

    // ---- F3 (fixed, T109): a write that is at the Vault when the sign-out clears the cache does not land after it ----
    it("F3: history being sealed during sign-out is not written after clearAllLocalData", async () => {
        const m = await start();
        const real = app.plugin.vaultWrap.getMockImplementation()!;
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        app.plugin.vaultWrap.mockImplementation(async (o) => { await gate; return real(o); });

        const write = m.db.saveHistoryToDB("c1", [{id: "m1", text: SECRET_TEXT}] as unknown as ChatMessage[]);
        const queue = m.db.saveOutboxToDB({messages: [], outboxVersion: 1, persistedVersion: 0} as never);
        const list = m.db.kvSet(m.db.KV.secretChats, {"c1": true});
        await new Promise((r) => setTimeout(r, 50));
        await m.db.clearAllLocalData();                                        // logoutResetClientState
        release();
        await Promise.all([write, queue, list]);
        expect(await (await m.db.initDB()).get(HISTORY_STORE_NAME, "c1")).toBeUndefined();
        expect(await m.db.loadOutboxFromDB()).toBeNull();
        expect(await m.db.kvGet(m.db.KV.secretChats)).toBeNull();

        await m.db.saveHistoryToDB("c1", [{id: "m2", text: "next account"}] as unknown as ChatMessage[]);   // a write asked for after the clear lands
        expect(await m.db.loadHistoryFromDB("c1")).toEqual([{id: "m2", text: "next account"}]);
    });

    // T109: a session that ended without a sign-out (401) erased nothing; the next account's sign-in does.
    it("F3: the cache of another account is erased when the owner check finds it, also while the lists are still being read", async () => {
        const m = await start();
        await m.db.kvSet(m.db.KV.secretChats, {"c-theirs": true});
        await m.db.kvSet(m.db.KV.stickyChats, {"c-theirs": {conversationId: "c-theirs", kind: "direct"}});
        await m.db.kvSet(m.db.KV.drafts, {"c-theirs": "their draft"});
        await m.db.saveHistoryToDB("c-theirs", [{id: "m1", text: SECRET_TEXT}] as unknown as ChatMessage[]);

        const n = await start();
        const real = app.plugin.vaultUnwrap.getMockImplementation()!;
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        app.plugin.vaultUnwrap.mockImplementation(async (o) => { await gate; return real(o); });   // the restore is waiting
        const store = n.configureAppStore(webrtc);
        await n.hydrateStore(store);
        await new Promise((r) => setTimeout(r, 100));
        const dropped = store.dispatch(n.dropForeignCache());
        release();
        await dropped;
        await vi.waitFor(() => expect(n.lists.listsReady()).toBe(true), {timeout: 3000});
        expect(store.getState().secretChats.byId).toEqual({});
        expect(store.getState().stickyChats.byId).toEqual({});
        expect(n.drafts.loadDraft("c-theirs")).toBe("");
        expect(await n.db.loadHistoryFromDB("c-theirs")).toBeNull();
    }, 10_000);

    // ---- F4 (fixed, T111): drafts moved from localStorage are written to the sealed record at once ----
    it("F4: a draft of the previous build is still there on the second start after the update", async () => {
        localStorage.setItem("wolp.drafts.v1", JSON.stringify({"c-plain": "half a sentence"}));
        const m = await start();
        const store = m.configureAppStore(webrtc);
        await m.hydrateStore(store);
        await vi.waitFor(() => expect(m.drafts.loadDraft("c-plain")).toBe("half a sentence"), {timeout: 3000});
        expect(localStorage.getItem("wolp.drafts.v1")).toBeNull();            // the open copy is removed
        await vi.waitFor(async () => expect(await m.db.kvGet(m.db.KV.drafts)).toEqual({"c-plain": "half a sentence"}), {timeout: 3000});

        const n = await start();                                               // the app is restarted
        const next = n.configureAppStore(webrtc);
        await n.hydrateStore(next);
        await vi.waitFor(() => expect(n.drafts.loadDraft("c-plain")).toBe("half a sentence"), {timeout: 3000});
    }, 10_000);

    // ---- F5 (fixed, T110): deleting a chat while the Vault is closed removes its attachment files too ----
    it("F5: deleteChatCache with a closed Vault removes the history record and the attachment file", async () => {
        const m = await start();
        await m.db.saveAttachmentBlob("att-1", new Blob([new TextEncoder().encode("PHOTO BYTES")]));
        await m.db.saveAttachmentBlob("att-other", new Blob([new TextEncoder().encode("ANOTHER CHAT")]));
        await m.db.saveHistoryToDB("c1", [{id: "m1", text: "", meta: {attachmentId: "att-1"}}] as unknown as ChatMessage[]);
        await m.db.saveHistoryToDB("c2", [{id: "m2", text: "", meta: {attachmentId: "att-other"}}] as unknown as ChatMessage[]);
        app.plugin.vaultUnwrap.mockImplementation(async () => { throw Object.assign(new Error("locked"), {code: "VAULT_LOCKED"}); });

        await m.db.deleteChatCache("c1");
        const d = await m.db.initDB();
        expect(await d.get(HISTORY_STORE_NAME, "c1")).toBeUndefined();
        expect(await d.get(ATTACHMENT_BLOB_STORE, "att-1")).toBeUndefined();  // the file is gone with the chat
        expect(await d.get(ATTACHMENT_BLOB_STORE, "att-other")).toBeDefined(); // another chat's file stays
        expect(await d.get(HISTORY_STORE_NAME, "c2")).toBeDefined();
    }, 10_000);
});
