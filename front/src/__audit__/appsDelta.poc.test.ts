import "fake-indexeddb/auto";
import {describe, it, expect, beforeEach, afterEach, vi} from "vitest";
import {installFakeApp} from "@/features/e2ee/lib/__tests__/fakeApp.ts";
import {abortVaultWaits} from "@/features/e2ee/lib/deviceKey.ts";
import type {WebRTCService} from "@/features/call/service/webRTCService.ts";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema";
import {ATTACHMENT_BLOB_STORE, HISTORY_STORE_NAME} from "@/shared/config/idb";

// Audit 2026-11-13, apps-delta: PoC tests against messenger-ui 2a3530d (F6 stage 5, sealed cache).

const webrtc = {setSendCallback: () => {}, setEventCallbacks: () => {}} as unknown as WebRTCService;
const SECRET_TEXT = "meet at the usual place at nine";

async function start() {
    vi.resetModules();
    const {configureAppStore, hydrateStore} = await import("@/store/store");
    const db = await import("@/features/chat/db/db");
    const drafts = await import("@/features/chat/model/drafts");
    const secret = await import("@/features/chat/model/slices/secretChatsSlice");
    const svc = await import("@/features/chat/model/services/chatMessages.service.ts");
    return {configureAppStore, hydrateStore, db, drafts, secret, svc};
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
    afterEach(() => { abortVaultWaits(); app.uninstall(); });

    // ---- F1: a chat the user made secret is treated as a normal chat until the Vault opens ----
    for (const [name, code] of [["the Vault is closed (RASP pass not finished / gate closed)", "VAULT_LOCKED"], ["the Vault key is gone", "VAULT_KEY_GONE"], ["the bridge answers UNAVAILABLE", "UNAVAILABLE"]] as const) {
        it(`F1: a message typed into a secret chat is queued in the clear while ${name}`, async () => {
            const m = await start();
            await m.db.kvSet(m.db.KV.secretChats, {"c-secret": true});       // the user turned secret mode on earlier

            const n = await start();                                          // cold start
            app.plugin.vaultUnwrap.mockImplementation(async () => { throw Object.assign(new Error(code), {code}); });
            const store = n.configureAppStore(webrtc);
            await n.hydrateStore(store);
            await new Promise((r) => setTimeout(r, 300));

            // What the composer does (useMessageComposer.ts:31,62): secret = !!secretChats.byId[chatId]
            const secret = !!store.getState().secretChats.byId["c-secret"];
            expect(secret).toBe(false);                                       // the mark is not known

            await n.svc.chatMessagesService.enqueueChatMessage(store.dispatch, SECRET_TEXT, "me", "c-secret", "peer", undefined, secret);
            const queued = store.getState().outbox.messages;
            expect(queued).toHaveLength(1);
            expect(JSON.stringify(queued[0].payload)).toContain(SECRET_TEXT); // plaintext on the wire frame
            expect(encrypt).not.toHaveBeenCalled();                           // nothing asked the library to encrypt
        }, 10_000);
    }

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

    it("F1b: after an unreadable start (UNAVAILABLE once) the next change replaces the stored list of secret chats", async () => {
        const m = await start();
        await m.db.kvSet(m.db.KV.secretChats, {"c-a": true, "c-b": true});

        const n = await start();
        const real = app.plugin.vaultUnwrap.getMockImplementation()!;
        let broken = true;
        app.plugin.vaultUnwrap.mockImplementation(async (o) => {
            if (broken) throw Object.assign(new Error("x"), {code: "UNAVAILABLE"});
            return real(o);
        });
        const store = n.configureAppStore(webrtc);
        await n.hydrateStore(store);
        await new Promise((r) => setTimeout(r, 300));
        broken = false;                                                        // the Vault works again
        store.dispatch(n.secret.markSecret("c-new"));
        await vi.waitFor(async () => expect(await n.db.kvGet(n.db.KV.secretChats)).toEqual({"c-new": true}), {timeout: 3000});
        // c-a and c-b are gone from disk: on the next start they are normal chats
    }, 10_000);

    // ---- F3: a write that is in the Vault when the sign-out clears the cache lands after the clear ----
    it("F3: history sealed during sign-out is written back after clearAllLocalData", async () => {
        const m = await start();
        const real = app.plugin.vaultWrap.getMockImplementation()!;
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        app.plugin.vaultWrap.mockImplementation(async (o) => { await gate; return real(o); });

        const write = m.db.saveHistoryToDB("c1", [{id: "m1", text: SECRET_TEXT}] as unknown as ChatMessage[]);
        await new Promise((r) => setTimeout(r, 50));
        await m.db.clearAllLocalData();                                        // logoutResetClientState
        expect(await (await m.db.initDB()).get(HISTORY_STORE_NAME, "c1")).toBeUndefined();
        release();
        await write;
        const left = await (await m.db.initDB()).get(HISTORY_STORE_NAME, "c1");
        expect(left).toBeDefined();                                            // the previous user's history is on disk again
        expect(await m.db.loadHistoryFromDB("c1")).toEqual([{id: "m1", text: SECRET_TEXT}]);   // and opens: no owner in the record
    });

    // ---- F4: drafts moved from localStorage are not written to the sealed record ----
    it("F4: a draft of the previous build is lost on the second start after the update", async () => {
        localStorage.setItem("wolp.drafts.v1", JSON.stringify({"c-plain": "half a sentence"}));
        const m = await start();
        const store = m.configureAppStore(webrtc);
        await m.hydrateStore(store);
        await vi.waitFor(() => expect(m.drafts.loadDraft("c-plain")).toBe("half a sentence"), {timeout: 3000});
        await new Promise((r) => setTimeout(r, 600));
        expect(localStorage.getItem("wolp.drafts.v1")).toBeNull();            // the open copy is removed
        expect(await m.db.kvGet(m.db.KV.drafts)).toBeNull();                  // and no sealed copy was written

        const n = await start();                                               // the app is restarted
        const next = n.configureAppStore(webrtc);
        await n.hydrateStore(next);
        await new Promise((r) => setTimeout(r, 600));
        expect(n.drafts.loadDraft("c-plain")).toBe("");                       // lost
    }, 10_000);

    // ---- F5: deleting a chat while the Vault is closed leaves its (unencrypted) attachment files ----
    it("F5: deleteChatCache with a closed Vault removes the history record and keeps the attachment file", async () => {
        const m = await start();
        await m.db.saveAttachmentBlob("att-1", new Blob([new TextEncoder().encode("PHOTO BYTES")]));
        await m.db.saveHistoryToDB("c1", [{id: "m1", text: "", meta: {attachmentId: "att-1"}}] as unknown as ChatMessage[]);
        app.plugin.vaultUnwrap.mockImplementation(async () => { throw Object.assign(new Error("locked"), {code: "VAULT_LOCKED"}); });

        await m.db.deleteChatCache("c1");
        const d = await m.db.initDB();
        expect(await d.get(HISTORY_STORE_NAME, "c1")).toBeUndefined();        // the list of its attachments is gone
        expect(await d.get(ATTACHMENT_BLOB_STORE, "att-1")).toBeDefined();    // the file stays, nothing points to it any more
    }, 10_000);
});
