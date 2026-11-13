import "fake-indexeddb/auto";
import {describe, it, expect, beforeEach, afterEach, vi} from "vitest";
import {installFakeApp} from "@/features/e2ee/lib/__tests__/fakeApp.ts";
import {abortVaultWaits} from "@/features/e2ee/lib/deviceKey.ts";
import {ATTACHMENT_BLOB_STORE, HISTORY_STORE_NAME, KV_STORE_NAME, STORE_KEY, STORE_NAME} from "@/shared/config/idb";
import type {OutboxState} from "@/features/chat/model/types";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema";

// Plan F6, stage 5: in the Android app the text the interface caches is on disk only as Vault blobs, and
// no key of it reaches JavaScript. Attachments are not encrypted (owner's decision 2026-11-13).

const TEXT = "the invoice is in the blue folder";
const history = [{id: "m1", text: TEXT}, {id: "m2", text: "second"}] as unknown as ChatMessage[];
const outbox = {messages: [{id: "o1", payload: {text: TEXT}}], outboxVersion: 1, persistedVersion: 0} as unknown as OutboxState;
const file = () => new Blob([new TextEncoder().encode(TEXT)], {type: "text/plain"});

type Db = typeof import("../db");
type Sealed = typeof import("../sealed");
/** A new start of the app: nothing in memory, the disk as it was. */
async function start(): Promise<Db & Sealed> {
    vi.resetModules();
    return {...(await import("../db")), ...(await import("../sealed"))};
}

describe("chat cache in the Android app", () => {
    let app: ReturnType<typeof installFakeApp>;
    let m: Db & Sealed;
    const raw = async (store: string, key: string) => (await m.initDB()).get(store, key);
    const purposes = (fn: {mock: {calls: unknown[][]}}) => fn.mock.calls.map(([o]) => (o as {purpose: string}).purpose);

    beforeEach(async () => {
        app = installFakeApp();
        localStorage.clear();
        m = await start();
        await m.clearAllLocalData();
        app.plugin.vaultWrap.mockClear();
        app.plugin.vaultUnwrap.mockClear();
    });
    afterEach(() => { abortVaultWaits(); app.uninstall(); });

    it("history, the send queue and a small value come back as they were saved", async () => {
        await m.saveHistoryToDB("c1", history);
        await m.saveOutboxToDB(outbox);
        await m.kvSet(m.KV.drafts, {c1: TEXT});

        expect(await m.loadHistoryFromDB("c1")).toEqual(history);
        expect(await m.loadOutboxFromDB()).toEqual(outbox);
        expect(await m.kvGet(m.KV.drafts)).toEqual({c1: TEXT});
        expect(await m.mediaStats()).toMatchObject({chats: 1, messages: 2});
    });

    it("every text record on disk is a Vault blob of the purpose chat-cache: one Vault call per record, no key in the interface", async () => {
        await m.saveHistoryToDB("c1", history);
        await m.saveOutboxToDB(outbox);
        await m.kvSet(m.KV.drafts, {c1: TEXT});

        for (const rec of [await raw(HISTORY_STORE_NAME, "c1"), await raw(STORE_NAME, STORE_KEY), await raw(KV_STORE_NAME, m.KV.drafts)]) {
            expect(m.isSealed(rec)).toBe(true);
            expect(Object.keys(rec as object).sort()).toEqual(["blob", "kind"]);   // nothing next to the blob
            expect(JSON.stringify(rec)).not.toContain(TEXT);
        }
        expect(purposes(app.plugin.vaultWrap)).toEqual(["chat-cache", "chat-cache", "chat-cache"]);

        await m.loadHistoryFromDB("c1");
        expect(purposes(app.plugin.vaultUnwrap)).toEqual(["chat-cache"]);
    });

    it("an attachment is cached as it is: the Vault is not called for it", async () => {
        await m.saveAttachmentBlob("a1", file());
        expect(m.isSealed(await raw(ATTACHMENT_BLOB_STORE, "a1"))).toBe(false);
        expect(await m.loadAttachmentBlob("a1")).not.toBeNull();
        expect(await m.mediaStats()).toMatchObject({files: 1});
        expect(app.plugin.vaultWrap).not.toHaveBeenCalled();
        expect(app.plugin.vaultUnwrap).not.toHaveBeenCalled();
    });

    it("a record moved to another chat does not open", async () => {
        await m.saveHistoryToDB("c1", history);
        await (await m.initDB()).put(HISTORY_STORE_NAME, await raw(HISTORY_STORE_NAME, "c1"), "c2");
        expect(await m.loadHistoryFromDB("c2")).toBeNull();
        expect(await m.loadHistoryFromDB("c1")).toEqual(history);
    });

    it("the history an earlier build left in the clear is not read and is erased once; the send queue is kept and sealed; attachments stay", async () => {
        const d = await m.initDB();
        await d.put(HISTORY_STORE_NAME, history, "c1");
        await d.put(STORE_NAME, outbox, STORE_KEY);
        await m.saveAttachmentBlob("a1", file());

        expect(await m.loadHistoryFromDB("c1")).toBeNull();
        expect(await m.loadOutboxFromDB()).toEqual(outbox);
        expect(m.isSealed(await raw(STORE_NAME, STORE_KEY))).toBe(true);

        await m.dropOpenCache();
        expect(await raw(HISTORY_STORE_NAME, "c1")).toBeUndefined();
        expect(await m.loadAttachmentBlob("a1")).not.toBeNull();
        expect(await m.loadOutboxFromDB()).toEqual(outbox);

        // once: a later start leaves the sealed history alone
        await m.saveHistoryToDB("c1", history);
        await m.dropOpenCache();
        expect(await m.loadHistoryFromDB("c1")).toEqual(history);
    });

    it("the Vault lost its keys: the old cache reads as empty and new records work", async () => {
        await m.saveHistoryToDB("c1", history);
        app.plugin.vaultUnwrap.mockRejectedValueOnce(Object.assign(new Error("gone"), {code: "VAULT_KEY_GONE"}));
        expect(await m.loadHistoryFromDB("c1")).toBeNull();
        await m.saveHistoryToDB("c1", history);
        expect(await m.loadHistoryFromDB("c1")).toEqual(history);
    });

    it("a locked phone: a read answers 'nothing cached' instead of hanging, and the cache is intact after the unlock", async () => {
        await m.saveHistoryToDB("c1", history);
        let locked = true;
        const unwrap = app.plugin.vaultUnwrap.getMockImplementation()!;
        app.plugin.vaultUnwrap.mockImplementation(async (o) => {
            if (locked) throw Object.assign(new Error("locked"), {code: "VAULT_LOCKED"});
            return unwrap(o);
        });
        const t0 = Date.now();
        expect(await m.loadHistoryFromDB("c1")).toBeNull();
        expect(Date.now() - t0).toBeLessThan(m.VAULT_WAIT_MS + 1000);

        locked = false;
        await vi.waitFor(async () => expect(await m.loadHistoryFromDB("c1")).toEqual(history), {timeout: 5000, interval: 200});
    }, 10_000);

    it("two writes of one record land in the order they were made, whatever the Vault takes", async () => {
        const wrap = app.plugin.vaultWrap.getMockImplementation()!;
        let first = true;
        app.plugin.vaultWrap.mockImplementation(async (o) => {
            if (first) { first = false; await new Promise((r) => setTimeout(r, 50)); }   // the older write is the slow one
            return wrap(o);
        });
        const older = m.kvSet(m.KV.drafts, {c1: "older"});
        const newer = m.kvSet(m.KV.drafts, {c1: "newer"});
        const h1 = m.saveHistoryToDB("c1", [history[0]]);
        const h2 = m.saveHistoryToDB("c1", history);
        await Promise.all([older, newer, h1, h2]);
        expect(await m.kvGet(m.KV.drafts)).toEqual({c1: "newer"});
        expect(await m.loadHistoryFromDB("c1")).toEqual(history);
    });

    it("sign-out erases the records", async () => {
        await m.saveHistoryToDB("c1", history);
        await m.kvSet(m.KV.names, {u1: "Ann"});
        await m.clearAllLocalData();
        expect(await raw(HISTORY_STORE_NAME, "c1")).toBeUndefined();
        expect(await raw(KV_STORE_NAME, m.KV.names)).toBeUndefined();
    });
});

describe("chat cache in a browser", () => {
    it("is stored as before, in the clear, and the Vault is not touched", async () => {
        const m = await start();
        await m.clearAllLocalData();
        await m.saveHistoryToDB("c1", history);
        expect(await (await m.initDB()).get(HISTORY_STORE_NAME, "c1")).toEqual(history);
        expect(await m.loadHistoryFromDB("c1")).toEqual(history);
        await m.kvSet(m.KV.drafts, {c1: TEXT});   // a browser keeps these in localStorage
        expect(await m.kvGet(m.KV.drafts)).toBeNull();
    });
});
