import {type IDBPDatabase, openDB} from 'idb';
import {
    DB_NAME, DB_VERSION, HISTORY_STORE_NAME, STORE_KEY, STORE_NAME,
    ATTACHMENT_BLOB_STORE, ATTACHMENT_INDEX_STORE, ATTACHMENT_INDEX_KEY,
    THUMB_STORE_NAME, THUMB_META_STORE, KV_STORE_NAME,
} from "@/shared/config/idb";
import {ATTACHMENT_CACHE_MAX_BYTES} from "@/shared/config/chat.ts";
import type {OutboxState} from "@/features/chat/model/types";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema";
import {isSecretEnvelope} from "@/features/e2ee/wire.ts";
import {fromDisk, readDisk, sealing, toDisk, type Read} from "./sealed.ts";

// In the Android app the records that hold text — the send queue, the history, the small values — are
// sealed by the app's Vault (sealed.ts): what is on disk is ciphertext. Attachment files are not encrypted
// (owner's decision 2026-11-13). In a browser everything is stored in the clear, as before. `place` binds
// a sealed record to its store and key.
const OUTBOX_PLACE = "outbox";
const INDEX_PLACE = "attachment-index";   // not sealed: only the name of its write queue
const historyPlace = (chatId: string) => `history|${chatId}`;
const kvPlace = (name: string) => `kv|${name}`;

// Sealing is a call to the app, so two writes of one record started one after the other could reach the disk
// in the other order — the older value over the newer. Writes of one place run one at a time, in the
// order they were asked for.
const writes = new Map<string, Promise<unknown>>();
function inOrder<T>(place: string, write: () => Promise<T>): Promise<T> {
    const next = (writes.get(place) ?? Promise.resolve()).then(write, write);
    writes.set(place, next);
    const done = () => { if (writes.get(place) === next) writes.delete(place); };
    next.then(done, done);
    return next;
}


// Sign-out clears the stores (clearAllLocalData) while a write may still be at the app, being sealed. Such
// a write must not land afterwards: the next account on this phone would read it. Every write notes the
// count of clears when it was asked for and gives up if a clear has happened since.
let clears = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dbPromise: Promise<IDBPDatabase<any>> | null = null;


export const initDB = async () => {
    if (!dbPromise) {
        dbPromise = openDB(DB_NAME, DB_VERSION, {
            upgrade(db) {
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
                // v2: per-conversation history cache, keyed by chatId.
                if (!db.objectStoreNames.contains(HISTORY_STORE_NAME)) {
                    db.createObjectStore(HISTORY_STORE_NAME);
                }
                // v5: unified, size-bounded media-attachment cache (images/audio/video) + its index.
                // Replaces the v3/v4 thumbnail-only stores, dropped here (just a cache — safe to lose).
                if (db.objectStoreNames.contains(THUMB_STORE_NAME)) db.deleteObjectStore(THUMB_STORE_NAME);
                if (db.objectStoreNames.contains(THUMB_META_STORE)) db.deleteObjectStore(THUMB_META_STORE);
                if (!db.objectStoreNames.contains(ATTACHMENT_BLOB_STORE)) {
                    db.createObjectStore(ATTACHMENT_BLOB_STORE);
                }
                if (!db.objectStoreNames.contains(ATTACHMENT_INDEX_STORE)) {
                    db.createObjectStore(ATTACHMENT_INDEX_STORE);
                }
                // v6: small sealed values of the Android app (see KV below).
                if (!db.objectStoreNames.contains(KV_STORE_NAME)) {
                    db.createObjectStore(KV_STORE_NAME);
                }
            },
        });
    }
    return dbPromise;
};

export async function saveOutboxToDB(data: OutboxState) {
    const at = clears;
    const db = await initDB();
    await inOrder(OUTBOX_PLACE, async () => {
        const rec = await toDisk(data, OUTBOX_PLACE);
        if (at !== clears) return;
        await db.put(STORE_NAME, rec, STORE_KEY);
    });
}

/** The stored send queue and how its read ended (sealed.ts, Read). Never throws: a storage error is `unread`. */
export async function readOutbox(): Promise<Read<OutboxState>> {
    try {
        const db = await initDB();
        const stored = await db.get(STORE_NAME, STORE_KEY);
        // The queue holds messages the user has not sent yet: wait for the key rather than report an empty queue.
        const result = await readDisk<OutboxState>(stored, OUTBOX_PLACE, {wait: true});
        if (result.state !== "none") return result;
        // A queue an earlier build of the app left in the clear: keep the unsent messages, seal them now.
        if (sealing() && stored && Array.isArray((stored as OutboxState).messages)) {
            await saveOutboxToDB(stored as OutboxState).catch(() => { /* sealed on the next change */ });
            return {state: "ok", value: stored as OutboxState};
        }
        return result;
    } catch {
        return {state: "unread"};
    }
}

/** The stored send queue, or null when there is none or it was not read. A caller that writes the queue
 * afterwards uses readOutbox. */
export async function loadOutboxFromDB(): Promise<OutboxState | null> {
    const r = await readOutbox();
    return r.state === "ok" ? r.value : null;
}

// --- per-conversation history cache -------------------------------------------------
// Secret (E2EE) rows NEVER go to this store — neither the decrypted text nor the envelope. The only
// on-disk copy of a secret message's text is the wrapped one in `e2ee-plaintext` (features/e2ee/lib/atRest);
// after a restart the rows come from the server and the text is restored from there. The rule lives in
// this one place so every present and future caller of saveHistoryToDB is covered. A read never waits
// for a locked phone longer than VAULT_WAIT_MS (sealed.ts): it answers "nothing cached".

/** A row that must not be written to disk: decrypted in memory (`secret`) or still an E2EE envelope. */
export function isSecretRow(m: Pick<ChatMessage, "secret" | "text">): boolean {
    return m?.secret === true || isSecretEnvelope(m?.text);
}

/** The rows allowed on disk: everything except secret ones. Same array back when nothing was dropped. */
export function toDiskRows(messages: ChatMessage[]): ChatMessage[] {
    if (!Array.isArray(messages)) return messages;
    const kept = messages.filter((m) => !isSecretRow(m));
    return kept.length === messages.length ? messages : kept;
}

export async function saveHistoryToDB(chatId: string, messages: ChatMessage[]) {
    if (!chatId) return;
    const at = clears;
    const db = await initDB();
    await inOrder(historyPlace(chatId), async () => {
        const rows = toDiskRows(messages);
        const rec = await toDisk(rows, historyPlace(chatId));
        if (at !== clears) return;
        await db.put(HISTORY_STORE_NAME, rec, chatId);
        // Which attachment files belong to this chat, kept open (the files are open too, their ids are
        // the keys of their store): deleteChatCache must find them while the Vault is closed.
        const files = attachmentIds(rows);
        if (files.length) await db.put(ATTACHMENT_INDEX_STORE, files, chatFilesKey(chatId));
        else await db.delete(ATTACHMENT_INDEX_STORE, chatFilesKey(chatId));
    });
}

const chatFilesKey = (chatId: string) => `chat|${chatId}`;
function attachmentIds(rows: ChatMessage[] | undefined): string[] {
    return Array.isArray(rows) ? rows.map((m) => m?.meta?.attachmentId).filter((a): a is string => !!a) : [];
}

export async function loadHistoryFromDB(chatId: string): Promise<ChatMessage[] | null> {
    if (!chatId) return null;
    const db = await initDB();
    const result = await fromDisk<ChatMessage[]>(await db.get(HISTORY_STORE_NAME, chatId), historyPlace(chatId));
    // Filter on read too: a record written by an earlier client version may still hold secret rows
    // until scrubHistoryCache has passed over it.
    return Array.isArray(result) ? toDiskRows(result) : null;
}

/**
 * Startup pass: rewrite every cached history record through toDiskRows, removing secret rows (and their
 * plaintext) left by earlier client versions. Idempotent — a clean cache is not written at all.
 * Best-effort: storage errors are swallowed. Returns how many records were rewritten. A sealed record
 * (Android app) is not an array and is skipped: it was written through toDiskRows already.
 */
export async function scrubHistoryCache(): Promise<number> {
    let rewritten = 0;
    try {
        const db = await initDB();
        const tx = db.transaction(HISTORY_STORE_NAME, "readwrite");
        let cursor = await tx.store.openCursor();
        while (cursor) {
            const rows = cursor.value as ChatMessage[];
            if (Array.isArray(rows)) {
                const kept = toDiskRows(rows);
                if (kept !== rows) { await cursor.update(kept); rewritten++; }
            }
            cursor = await cursor.continue();
        }
        await tx.done;
    } catch { /* best-effort */ }
    return rewritten;
}

// --- unified media-attachment cache (images / voice notes / video) ------------------
// Size-bounded, oldest-first eviction. The index (ATTACHMENT_INDEX_STORE[ATTACHMENT_INDEX_KEY]) is one
// array of {id,size} in insertion order, so the total byte size and the eviction victims are known
// without reading any blob. The blob write and the index update aren't a single transaction — a rare
// concurrent save may over/under-count momentarily, which is harmless for a cache (never a correctness
// issue; the cap stays approximate). The newest entry is always kept even if it alone exceeds the budget.
export type CacheIndexEntry = {id: string; size: number};

/**
 * Pure oldest-first eviction: given the insertion-ordered index and a byte budget, return the entries to
 * keep and the ids to evict so the total fits. The newest entry (last) is always kept even if it alone
 * exceeds the budget. Exported for unit testing (IndexedDB isn't available in jsdom).
 */
export function evictToFit(entries: CacheIndexEntry[], maxBytes: number): {kept: CacheIndexEntry[]; evicted: string[]} {
    const kept = [...entries];
    const evicted: string[] = [];
    let total = kept.reduce((sum, e) => sum + e.size, 0);
    while (total > maxBytes && kept.length > 1) {
        const e = kept.shift();
        if (e) { evicted.push(e.id); total -= e.size; }
    }
    return {kept, evicted};
}

async function readCacheIndex(db: IDBPDatabase<unknown>): Promise<CacheIndexEntry[]> {
    const index = await db.get(ATTACHMENT_INDEX_STORE, ATTACHMENT_INDEX_KEY);
    return Array.isArray(index) ? index as CacheIndexEntry[] : [];
}

async function writeCacheIndex(db: IDBPDatabase<unknown>, index: CacheIndexEntry[]): Promise<void> {
    await db.put(ATTACHMENT_INDEX_STORE, index, ATTACHMENT_INDEX_KEY);
}

export async function saveAttachmentBlob(attachmentId: string, blob: Blob) {
    if (!attachmentId || !blob) return;
    const at = clears;
    const db = await initDB();
    // The index is read, changed and written back: one such change at a time.
    await inOrder(INDEX_PLACE, async () => {
        if (at !== clears) return;
        await db.put(ATTACHMENT_BLOB_STORE, blob, attachmentId);
        const index = await readCacheIndex(db);
        const next = [...index.filter((e) => e.id !== attachmentId), {id: attachmentId, size: blob.size || 0}];
        const {kept, evicted} = evictToFit(next, ATTACHMENT_CACHE_MAX_BYTES);
        for (const id of evicted) await db.delete(ATTACHMENT_BLOB_STORE, id);
        await writeCacheIndex(db, kept);
    });
}

export async function loadAttachmentBlob(attachmentId: string): Promise<Blob | null> {
    if (!attachmentId) return null;
    const db = await initDB();
    const result = await db.get(ATTACHMENT_BLOB_STORE, attachmentId);
    return (result as Blob) ?? null;
}

// Drop one cached attachment (its message was deleted, or the blob was stale/corrupt) — blob + index.
export async function deleteAttachmentBlob(attachmentId: string) {
    if (!attachmentId) return;
    const db = await initDB();
    await inOrder(INDEX_PLACE, async () => {
        await db.delete(ATTACHMENT_BLOB_STORE, attachmentId);
        const index = await readCacheIndex(db);
        if (index.some((e) => e.id === attachmentId)) {
            await writeCacheIndex(db, index.filter((e) => e.id !== attachmentId));
        }
    });
}

// Wipe all locally-cached user data (outbox queue + per-conversation history + media cache). Called on
// logout so one user's queued messages, plaintext history and media never linger for the next user.
export async function clearAllLocalData() {
    clears++;   // writes asked for before this line do not land after it
    const db = await initDB();
    await Promise.all([
        db.clear(STORE_NAME), db.clear(HISTORY_STORE_NAME),
        db.clear(ATTACHMENT_BLOB_STORE), db.clear(ATTACHMENT_INDEX_STORE), db.clear(KV_STORE_NAME),
    ]);
}

/** Storage breakdown for the info page: attachment files (count + bytes) and cached history (chats + msgs). */
export async function mediaStats(): Promise<{files: number; fileBytes: number; chats: number; messages: number}> {
    try {
        const db = await initDB();
        const blobs = (await db.getAll(ATTACHMENT_BLOB_STORE)) as unknown[];
        let fileBytes = 0;
        for (const b of blobs) fileBytes += b instanceof Blob ? b.size : ((b as {byteLength?: number})?.byteLength ?? 0);
        const chatIds = (await db.getAllKeys(HISTORY_STORE_NAME)) as string[];
        let messages = 0;
        for (const chatId of chatIds) {
            const rows = await fromDisk<ChatMessage[]>(await db.get(HISTORY_STORE_NAME, chatId), historyPlace(chatId));
            if (Array.isArray(rows)) messages += rows.length;
        }
        return {files: blobs.length, fileBytes, chats: chatIds.length, messages};
    } catch { return {files: 0, fileBytes: 0, chats: 0, messages: 0}; }
}

/** Purge a deleted chat's LOCAL caches: its attachment files (blobs) and its cached history rows. (The
 * E2EE plaintext is cleared separately via deletePlaintextForChat.) Best-effort. */
export async function deleteChatCache(chatId: string): Promise<void> {
    try {
        const db = await initDB();
        const msgs = await fromDisk<ChatMessage[]>(await db.get(HISTORY_STORE_NAME, chatId), historyPlace(chatId));
        // The open list of the chat's files as well: with the Vault closed the history does not open, and
        // the files would stay with nothing pointing to them.
        const listed = await db.get(ATTACHMENT_INDEX_STORE, chatFilesKey(chatId));
        const aids = Array.from(new Set([...attachmentIds(msgs), ...(Array.isArray(listed) ? listed as string[] : [])]));
        for (const aid of aids) await db.delete(ATTACHMENT_BLOB_STORE, aid).catch(() => {});
        if (aids.length) {
            // The index store holds ONE array-of-{id,size} record (keyed by ATTACHMENT_INDEX_KEY); the
            // blobs are keyed by attachmentId. So the removed ids are filtered OUT of that array — a
            // db.delete(ATTACHMENT_INDEX_STORE, aid) would silently miss (wrong key shape) and leak the
            // byte accounting, which was the pre-existing bug.
            const dropped = new Set(aids);
            const index = await readCacheIndex(db);
            const next = index.filter((e) => !dropped.has(e.id));
            if (next.length !== index.length) await writeCacheIndex(db, next);
        }
        await db.delete(ATTACHMENT_INDEX_STORE, chatFilesKey(chatId));
        await db.delete(HISTORY_STORE_NAME, chatId);
    } catch { /* best-effort */ }
}

/** The chatIds that currently have a cached history entry (used by the startup orphan sweep). */
export async function historyChatIds(): Promise<string[]> {
    try {
        const db = await initDB();
        return (await db.getAllKeys(HISTORY_STORE_NAME)) as string[];
    } catch { return []; }
}

/** Drop index entries whose blob no longer exists — repairs byte-accounting drift from earlier deletes so
 * the cache budget and the info page don't over-count. Best-effort; returns how many stale entries fell. */
export async function pruneAttachmentIndex(): Promise<number> {
    try {
        const db = await initDB();
        const liveBlobs = new Set((await db.getAllKeys(ATTACHMENT_BLOB_STORE)) as string[]);
        const index = await readCacheIndex(db);
        const next = index.filter((e) => liveBlobs.has(e.id));
        if (next.length !== index.length) {
            await writeCacheIndex(db, next);
            return index.length - next.length;
        }
    } catch { /* best-effort */ }
    return 0;
}

// --- small sealed values (Android app only) ------------------------------------------
// What a browser keeps in localStorage — drafts, the lists of secret and sticky chats — and the name
// cache: in the app each is one sealed record here.
export const KV = {drafts: "drafts", secretChats: "secretChats", stickyChats: "stickyChats", names: "names"} as const;
export type KvName = typeof KV[keyof typeof KV];

/** The stored value and how its read ended (sealed.ts, Read). Never throws: a storage error is `unread`. */
export async function kvRead<T>(name: KvName, opts?: {wait?: boolean}): Promise<Read<T>> {
    try {
        const db = await initDB();
        return await readDisk<T>(await db.get(KV_STORE_NAME, name), kvPlace(name), opts);
    } catch {
        return {state: "unread"};
    }
}

/** The stored value, or null. `wait` — wait for the key instead of answering null. */
export async function kvGet<T>(name: KvName, opts?: {wait?: boolean}): Promise<T | null> {
    const db = await initDB();
    return (await fromDisk<T>(await db.get(KV_STORE_NAME, name), kvPlace(name), opts)) ?? null;
}

export async function kvSet(name: KvName, value: unknown): Promise<void> {
    if (!sealing()) return;   // a browser keeps these in localStorage
    const at = clears;
    const db = await initDB();
    await inOrder(kvPlace(name), async () => {
        const rec = await toDisk(value, kvPlace(name));
        if (at !== clears) return;
        await db.put(KV_STORE_NAME, rec, name);
    });
}

// A build before 10097 stored the history in the clear. It is a cache: erased once, not converted (the send queue is converted — see loadOutboxFromDB). The mark is not user data.
const SEALED_MARK = "wolp.cacheSealed";
const OPEN_NAMES_DB = "wolp-names";

/** Android app, once after the update: erase the text an earlier build left on disk in the clear. Best-effort. */
export async function dropOpenCache(): Promise<void> {
    if (!sealing()) return;
    try {
        if (localStorage.getItem(SEALED_MARK) === "1") return;
        const db = await initDB();
        await db.clear(HISTORY_STORE_NAME);
        await new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(OPEN_NAMES_DB);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
        });
        localStorage.setItem(SEALED_MARK, "1");
    } catch { /* tried again on the next start */ }
}
