import {openDB, type IDBPDatabase} from "idb";
import {E2EE_DB} from "./stores.ts";
import {wrapBytes, unwrapBytes, isNativeWrapped, type Wrapped} from "./deviceKey.ts";
import {logger} from "@/shared/logger/logger.ts";

// At-rest plaintext store (Phase 2e). A Double Ratchet message key is CONSUMED on first decrypt and then
// deleted (forward secrecy), so a secret message can be decrypted exactly ONCE — re-decrypting the same
// envelope from reloaded history is impossible. So the moment we decrypt (on receipt) — and the moment we
// send — we stash the plaintext here, RE-ENCRYPTED under the device key, keyed by message id. History
// rendering reads plaintext from here instead of re-running the ratchet. On disk it's ciphertext
// (device-key-wrapped); only a live origin can unwrap it. Each record carries its chatId (so clearing a
// chat wipes its plaintext) and savedAt (for disappearing-message expiry). Best-effort — never throws.

const STORE = "pt";
const V = 2;                                // v2 adds chatId + the by-chat index
const PURPOSE = "e2ee-plaintext";           // Android app: Vault purpose of stored plaintext (S1 §5.1)

// Disappearing secret messages: a stored decrypted plaintext is auto-deleted this long after it was saved.
// After that the message reads "🕗 expired" (aged out — the ratchet key is long gone, so it's unrecoverable
// by design; this is NOT a decrypt failure). 7 days, global.
export const E2EE_PLAINTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const enc = new TextEncoder(), dec = new TextDecoder();

// `to` (the intended recipient) is set ONLY on the sender's own outgoing record. It authorizes
// client-to-client recovery: the sender re-sends a plaintext only to the recipient it was addressed to,
// never to whoever asks (a server-visible clientId must not become a plaintext oracle). Received records
// leave it unset — they are never served for recovery.
interface Rec { chatId: string; savedAt: number; w: Wrapped; to?: string }

/** A stored plaintext with the metadata recovery needs to authorize a re-send. */
export interface PlaintextRecord { text: string; chatId: string; to?: string }

let dbp: Promise<IDBPDatabase> | null = null;
function db(): Promise<IDBPDatabase> {
    if (!dbp) {
        const p: Promise<IDBPDatabase> = openDB(E2EE_DB.plaintext, V, {
            upgrade(d, _old, _new, tx) {
                const s = d.objectStoreNames.contains(STORE) ? tx.objectStore(STORE) : d.createObjectStore(STORE);
                if (!s.indexNames.contains("chatId")) s.createIndex("chatId", "chatId");
            },
            // A wipe (logout) asks to delete this database: let go at once, or the deletion stays blocked.
            blocking() { if (dbp === p) dbp = null; void p.then((d) => d.close(), () => {}); },
        });
        dbp = p;
    }
    return dbp;
}

/** Stash a decrypted/sent secret message's plaintext under its id (wrapped), tagged with its chat. Pass
 * `to` (the recipient's userId) ONLY for our own outgoing message, so recovery can re-send just to them. */
// This store holds the ONLY copy the client can show after a reload: the ratchet gives each message key
// once. So a failed save is tried again, and if it still fails the caller is told (it marks the message
// "not saved on this device") — it is never swallowed. The message text never goes to the log.
export const SAVE_ATTEMPTS = 3;
export const SAVE_RETRY_MS = 300;

/** Returns true when the text is stored, false when every attempt failed. Never throws. */
export async function savePlaintext(id: string, chatId: string, text: string, to?: string): Promise<boolean> {
    if (!id) return true;   // nothing to key the record by: not a storage failure
    for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt++) {
        try {
            const rec: Rec = {chatId, savedAt: Date.now(), w: await wrapBytes(enc.encode(text).buffer, PURPOSE), ...(to ? {to} : {})};
            await (await db()).put(STORE, rec, id);
            return true;
        } catch (e) {
            if (attempt === SAVE_ATTEMPTS) {
                logger.warn("e2ee: decrypted text was not saved on this device", {id, chatId, error: (e as Error)?.name ?? "error"});
                return false;
            }
            await new Promise((r) => setTimeout(r, SAVE_RETRY_MS));
        }
    }
    return false;
}

/** Load a plaintext record with its recovery metadata (chatId + intended recipient), honouring the TTL.
 * Returns null if absent/expired. Used by the recovery responder to authorize a re-send. */
export async function loadPlaintextRecord(id: string, ttlMs?: number): Promise<PlaintextRecord | null> {
    try {
        const d = await db();
        const rec = (await d.get(STORE, id)) as Rec | Wrapped | undefined;
        if (!rec) return null;
        const w = "w" in rec ? rec.w : rec;
        const savedAt = "savedAt" in rec ? rec.savedAt : 0;
        const chatId = "chatId" in rec ? rec.chatId : "";
        const to = "to" in rec ? rec.to : undefined;
        if (ttlMs && savedAt && Date.now() - savedAt > ttlMs) { await d.delete(STORE, id).catch(() => {}); return null; }
        return {text: dec.decode(await unwrapBytes(w, PURPOSE)), chatId, to};
    } catch { return null; }
}

/**
 * Recover a stored plaintext by id, or null if we never decrypted/sent it on this device. If ttlMs is given
 * and the record is older, it's treated as EXPIRED — deleted and null returned (disappearing messages).
 */
export async function loadPlaintext(id: string, ttlMs?: number): Promise<string | null> {
    try {
        const d = await db();
        const rec = (await d.get(STORE, id)) as Rec | Wrapped | undefined;
        if (!rec) return null;
        // Tolerate a v1 record (bare Wrapped, no chatId/savedAt) written before the upgrade.
        const w = "w" in rec ? rec.w : rec;
        const savedAt = "savedAt" in rec ? rec.savedAt : 0;
        if (ttlMs && savedAt && Date.now() - savedAt > ttlMs) { await d.delete(STORE, id).catch(() => {}); return null; }
        return dec.decode(await unwrapBytes(w, PURPOSE));
    } catch { return null; }
}

/** Wipe every stored plaintext for a chat — called when the user clears/deletes that chat locally. */
export async function deletePlaintextForChat(chatId: string): Promise<void> {
    try {
        const d = await db();
        const tx = d.transaction(STORE, "readwrite");
        let cur = await tx.store.index("chatId").openCursor(IDBKeyRange.only(chatId));
        while (cur) { await cur.delete(); cur = await cur.continue(); }
        await tx.done;
    } catch { /* best-effort */ }
}

/** The distinct chatIds that have stored plaintext (for the startup orphan sweep). Skips v1 records (no
 * chatId) — those pre-date the tag and can't be attributed to a chat, so the sweep leaves them to the TTL. */
export async function plaintextChatIds(): Promise<string[]> {
    try {
        const d = await db();
        const vals = (await d.getAll(STORE)) as Array<Rec | Wrapped>;
        const ids = new Set<string>();
        for (const v of vals) if ("chatId" in v && v.chatId) ids.add(v.chatId);
        return [...ids];
    } catch { return []; }
}

/** Count + on-disk bytes of stored secret plaintext (device-key-wrapped), for the info page. */
export async function plaintextStats(): Promise<{count: number; bytes: number}> {
    try {
        const d = await db();
        const vals = (await d.getAll(STORE)) as Array<Rec | Wrapped>;
        let bytes = 0;
        for (const v of vals) {
            const w = "w" in v ? v.w : v;
            bytes += !w ? 0 : isNativeWrapped(w) ? Math.floor(w.blob.length * 3 / 4) : (w.ct?.byteLength ?? 0) + (w.iv?.byteLength ?? 0);
        }
        return {count: vals.length, bytes};
    } catch { return {count: 0, bytes: 0}; }
}

/** Sweep all plaintext older than ttlMs across every chat (disappearing-message GC). Returns count removed. */
export async function sweepExpired(ttlMs: number): Promise<number> {
    let n = 0;
    try {
        const d = await db();
        const cutoff = Date.now() - ttlMs;
        const tx = d.transaction(STORE, "readwrite");
        let cur = await tx.store.openCursor();
        while (cur) {
            const rec = cur.value as Rec;
            if (rec?.savedAt && rec.savedAt < cutoff) { await cur.delete(); n++; }
            cur = await cur.continue();
        }
        await tx.done;
    } catch { /* best-effort */ }
    return n;
}
