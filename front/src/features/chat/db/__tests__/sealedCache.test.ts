import "fake-indexeddb/auto";
import {describe, it, expect, beforeEach, afterEach, vi} from "vitest";
import {installFakeApp} from "@/features/e2ee/lib/__tests__/fakeApp.ts";
import {abortVaultWaits} from "@/features/e2ee/lib/deviceKey.ts";
import {
    ATTACHMENT_BLOB_STORE, ATTACHMENT_INDEX_STORE, ATTACHMENT_INDEX_KEY, HISTORY_STORE_NAME, KV_STORE_NAME,
    STORE_KEY, STORE_NAME,
} from "@/shared/config/idb";
import type {OutboxState} from "@/features/chat/model/types";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema";

// Plan F6, stage 5: in the Android app nothing the interface caches is on disk in the clear.

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

/** Every byte of a stored record, as text: what a search over the app's files would see. */
function onDisk(rec: unknown): string {
    const parts: string[] = [];
    const walk = (v: unknown) => {
        if (v instanceof ArrayBuffer) parts.push(new TextDecoder("latin1").decode(v));
        else if (ArrayBuffer.isView(v)) parts.push(new TextDecoder("latin1").decode(v as Uint8Array));
        else if (typeof v === "string") parts.push(v);
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { parts.push(k); walk(x); }
    };
    walk(rec);
    return parts.join("\n");
}

describe("chat cache in the Android app", () => {
    let app: ReturnType<typeof installFakeApp>;
    let m: Db & Sealed;
    const raw = async (store: string, key: string) => (await m.initDB()).get(store, key);
    const wraps = () => app.plugin.vaultWrap.mock.calls.length;

    beforeEach(async () => {
        app = installFakeApp();
        localStorage.clear();
        m = await start();
        await m.clearAllLocalData();
        app.plugin.vaultWrap.mockClear();
        app.plugin.vaultUnwrap.mockClear();
    });
    afterEach(() => { abortVaultWaits(); app.uninstall(); });

    it("history, the send queue, an attachment and a small value come back as they were saved", async () => {
        await m.saveHistoryToDB("c1", history);
        await m.saveOutboxToDB(outbox);
        await m.saveAttachmentBlob("a1", file());
        await m.kvSet(m.KV.drafts, {c1: TEXT});

        expect(await m.loadHistoryFromDB("c1")).toEqual(history);
        expect(await m.loadOutboxFromDB()).toEqual(outbox);
        const blob = await m.loadAttachmentBlob("a1");
        expect(blob?.type).toBe("text/plain");
        expect(blob?.size).toBe(TEXT.length);
        expect(await m.kvGet(m.KV.drafts)).toEqual({c1: TEXT});
        expect(await m.mediaStats()).toMatchObject({files: 1, chats: 1, messages: 2});
    });

    it("nothing on disk holds the text", async () => {
        await m.saveHistoryToDB("c1", history);
        await m.saveOutboxToDB(outbox);
        await m.saveAttachmentBlob("a1", file());
        await m.kvSet(m.KV.drafts, {c1: TEXT});

        const records = [
            await raw(HISTORY_STORE_NAME, "c1"), await raw(STORE_NAME, STORE_KEY), await raw(ATTACHMENT_BLOB_STORE, "a1"),
            await raw(ATTACHMENT_INDEX_STORE, ATTACHMENT_INDEX_KEY), await raw(KV_STORE_NAME, m.KV.drafts),
        ];
        for (const rec of records) {
            expect(m.isSealed(rec)).toBe(true);
            expect(onDisk(rec)).not.toContain(TEXT);
            expect(onDisk(rec)).not.toContain("a1");
        }
    });

    it("the Vault is asked once, for the key, with the purpose chat-cache — not once per record", async () => {
        await m.saveHistoryToDB("c1", history);
        await m.saveHistoryToDB("c2", history);
        await m.saveAttachmentBlob("a1", file());
        await m.loadHistoryFromDB("c1");
        expect(app.plugin.vaultWrap).toHaveBeenCalledTimes(1);
        expect(app.plugin.vaultWrap.mock.calls[0][0].purpose).toBe("chat-cache");
        expect(app.plugin.vaultUnwrap).not.toHaveBeenCalled();

        m = await start();   // the next start unwraps the same key
        expect(await m.loadHistoryFromDB("c1")).toEqual(history);
        expect(app.plugin.vaultUnwrap).toHaveBeenCalledTimes(1);
        expect(app.plugin.vaultUnwrap.mock.calls[0][0].purpose).toBe("chat-cache");
        expect(wraps()).toBe(1);
    });

    it("a record moved to another chat does not open", async () => {
        await m.saveHistoryToDB("c1", history);
        await (await m.initDB()).put(HISTORY_STORE_NAME, await raw(HISTORY_STORE_NAME, "c1"), "c2");
        expect(await m.loadHistoryFromDB("c2")).toBeNull();
        expect(await m.loadHistoryFromDB("c1")).toEqual(history);
    });

    it("what an earlier build left in the clear is not read and is erased once; the send queue is kept and sealed", async () => {
        const d = await m.initDB();
        await d.put(HISTORY_STORE_NAME, history, "c1");
        await d.put(ATTACHMENT_BLOB_STORE, new Uint8Array([1, 2, 3]).buffer, "a1");
        await d.put(STORE_NAME, outbox, STORE_KEY);

        expect(await m.loadHistoryFromDB("c1")).toBeNull();
        expect(await m.loadAttachmentBlob("a1")).toBeNull();
        expect(await m.loadOutboxFromDB()).toEqual(outbox);
        expect(m.isSealed(await raw(STORE_NAME, STORE_KEY))).toBe(true);

        await m.dropOpenCache();
        expect(await raw(HISTORY_STORE_NAME, "c1")).toBeUndefined();
        expect(await raw(ATTACHMENT_BLOB_STORE, "a1")).toBeUndefined();
        expect(await m.loadOutboxFromDB()).toEqual(outbox);

        // once: a later start leaves the sealed cache alone
        await m.saveHistoryToDB("c1", history);
        await m.dropOpenCache();
        expect(await m.loadHistoryFromDB("c1")).toEqual(history);
    });

    it("the Vault lost its keys: a new key, the old cache reads as empty", async () => {
        await m.saveHistoryToDB("c1", history);
        m = await start();
        app.plugin.vaultUnwrap.mockRejectedValueOnce(Object.assign(new Error("gone"), {code: "VAULT_KEY_GONE"}));
        expect(await m.loadHistoryFromDB("c1")).toBeNull();
        expect(wraps()).toBe(2);
        await m.saveHistoryToDB("c1", history);
        expect(await m.loadHistoryFromDB("c1")).toEqual(history);
    });

    it("a locked phone: a read answers 'nothing cached' instead of hanging, and the cache is intact after the unlock", async () => {
        await m.saveHistoryToDB("c1", history);
        m = await start();
        let locked = true;
        const unwrap = app.plugin.vaultUnwrap.getMockImplementation()!;
        app.plugin.vaultUnwrap.mockImplementation(async (o) => {
            if (locked) throw Object.assign(new Error("locked"), {code: "VAULT_LOCKED"});
            return unwrap(o);
        });
        const t0 = Date.now();
        expect(await m.loadHistoryFromDB("c1")).toBeNull();
        expect(Date.now() - t0).toBeLessThan(m.KEY_WAIT_MS + 1000);
        expect(wraps()).toBe(1);   // no new key was made: nothing is lost

        locked = false;
        await vi.waitFor(async () => expect(await m.loadHistoryFromDB("c1")).toEqual(history), {timeout: 5000, interval: 200});
    }, 10_000);

    it("sign-out: the records and the key are erased, the next account gets its own key", async () => {
        await m.saveHistoryToDB("c1", history);
        await m.kvSet(m.KV.names, {u1: "Ann"});
        await m.clearAllLocalData();
        expect(await raw(HISTORY_STORE_NAME, "c1")).toBeUndefined();
        expect(await raw(KV_STORE_NAME, m.KV.names)).toBeUndefined();
        await m.saveHistoryToDB("c1", history);
        expect(wraps()).toBe(2);
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
