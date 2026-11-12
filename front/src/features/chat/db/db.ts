import {type IDBPDatabase, openDB} from 'idb';
import {
    DB_NAME, DB_VERSION, HISTORY_STORE_NAME, STORE_KEY, STORE_NAME,
    ATTACHMENT_BLOB_STORE, ATTACHMENT_INDEX_STORE, ATTACHMENT_INDEX_KEY,
    THUMB_STORE_NAME, THUMB_META_STORE,
} from "@/shared/config/idb";
import {ATTACHMENT_CACHE_MAX_BYTES} from "@/shared/config/chat.ts";
import type {OutboxState} from "@/features/chat/model/types";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema";
import {isSecretEnvelope} from "@/features/e2ee/lib/secretChat.ts";


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
            },
        });
    }
    return dbPromise;
};

export async function saveOutboxToDB(data: OutboxState) {
    const db = await initDB();
    await db.put(STORE_NAME, data, STORE_KEY);
}

export async function loadOutboxFromDB(): Promise<OutboxState | null> {
    const db = await initDB();
    const result = await db.get(STORE_NAME, STORE_KEY);
    return result ?? null;
}

// --- per-conversation history cache -------------------------------------------------
// Secret (E2EE) rows NEVER go to this store — neither the decrypted text nor the envelope. The only
// on-disk copy of a secret message's text is the wrapped one in `e2ee-plaintext` (features/e2ee/lib/atRest);
// after a restart the rows come from the server and the text is restored from there. The rule lives in
// this one place so every present and future caller of saveHistoryToDB is covered. Nothing here touches
// the device key / Vault, so a locked Vault never delays the cache.

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
    const db = await initDB();
    await db.put(HISTORY_STORE_NAME, toDiskRows(messages), chatId);
}

export async function loadHistoryFromDB(chatId: string): Promise<ChatMessage[] | null> {
    if (!chatId) return null;
    const db = await initDB();
    const result = await db.get(HISTORY_STORE_NAME, chatId);
    // Filter on read too: a record written by an earlier client version may still hold secret rows
    // until scrubHistoryCache has passed over it.
    return result ? toDiskRows(result as ChatMessage[]) : null;
}

/**
 * Startup pass: rewrite every cached history record through toDiskRows, removing secret rows (and their
 * plaintext) left by earlier client versions. Idempotent — a clean cache is not written at all.
 * Best-effort: storage errors are swallowed. Returns how many records were rewritten.
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
    return ((await db.get(ATTACHMENT_INDEX_STORE, ATTACHMENT_INDEX_KEY)) as CacheIndexEntry[] | undefined) ?? [];
}

export async function saveAttachmentBlob(attachmentId: string, blob: Blob) {
    if (!attachmentId || !blob) return;
    const db = await initDB();
    await db.put(ATTACHMENT_BLOB_STORE, blob, attachmentId);
    const index = await readCacheIndex(db);
    const next = [...index.filter((e) => e.id !== attachmentId), {id: attachmentId, size: blob.size || 0}];
    const {kept, evicted} = evictToFit(next, ATTACHMENT_CACHE_MAX_BYTES);
    for (const id of evicted) await db.delete(ATTACHMENT_BLOB_STORE, id);
    await db.put(ATTACHMENT_INDEX_STORE, kept, ATTACHMENT_INDEX_KEY);
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
    await db.delete(ATTACHMENT_BLOB_STORE, attachmentId);
    const index = await readCacheIndex(db);
    if (index.some((e) => e.id === attachmentId)) {
        await db.put(ATTACHMENT_INDEX_STORE, index.filter((e) => e.id !== attachmentId), ATTACHMENT_INDEX_KEY);
    }
}

// Wipe all locally-cached user data (outbox queue + per-conversation history + media cache). Called on
// logout so one user's queued messages, plaintext history and media never linger for the next user.
export async function clearAllLocalData() {
    const db = await initDB();
    await Promise.all([
        db.clear(STORE_NAME), db.clear(HISTORY_STORE_NAME),
        db.clear(ATTACHMENT_BLOB_STORE), db.clear(ATTACHMENT_INDEX_STORE),
    ]);
}

/** Storage breakdown for the info page: attachment files (count + bytes) and cached history (chats + msgs). */
export async function mediaStats(): Promise<{files: number; fileBytes: number; chats: number; messages: number}> {
    try {
        const db = await initDB();
        const blobs = (await db.getAll(ATTACHMENT_BLOB_STORE)) as unknown[];
        let fileBytes = 0;
        for (const b of blobs) fileBytes += b instanceof Blob ? b.size : ((b as {byteLength?: number})?.byteLength ?? 0);
        const histories = (await db.getAll(HISTORY_STORE_NAME)) as unknown[][];
        const messages = histories.reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
        return {files: blobs.length, fileBytes, chats: histories.length, messages};
    } catch { return {files: 0, fileBytes: 0, chats: 0, messages: 0}; }
}

/** Purge a deleted chat's LOCAL caches: its attachment files (blobs) and its cached history rows. (The
 * E2EE plaintext is cleared separately via deletePlaintextForChat.) Best-effort. */
export async function deleteChatCache(chatId: string): Promise<void> {
    try {
        const db = await initDB();
        const msgs = (await db.get(HISTORY_STORE_NAME, chatId)) as ChatMessage[] | undefined;
        const aids = Array.isArray(msgs)
            ? msgs.map((m) => m?.meta?.attachmentId).filter((a): a is string => !!a)
            : [];
        for (const aid of aids) await db.delete(ATTACHMENT_BLOB_STORE, aid).catch(() => {});
        if (aids.length) {
            // The index store holds ONE array-of-{id,size} record (keyed by ATTACHMENT_INDEX_KEY); the
            // blobs are keyed by attachmentId. So the removed ids are filtered OUT of that array — a
            // db.delete(ATTACHMENT_INDEX_STORE, aid) would silently miss (wrong key shape) and leak the
            // byte accounting, which was the pre-existing bug.
            const dropped = new Set(aids);
            const index = await readCacheIndex(db);
            const next = index.filter((e) => !dropped.has(e.id));
            if (next.length !== index.length) await db.put(ATTACHMENT_INDEX_STORE, next, ATTACHMENT_INDEX_KEY);
        }
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
            await db.put(ATTACHMENT_INDEX_STORE, next, ATTACHMENT_INDEX_KEY);
            return index.length - next.length;
        }
    } catch { /* best-effort */ }
    return 0;
}
