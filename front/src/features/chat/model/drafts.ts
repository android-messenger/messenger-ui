// Per-conversation composer drafts, persisted in localStorage so an unsent message survives switching
// chats, closing the tab, or a reload. One JSON map { chatId: text } under a versioned key. Empty text
// removes the entry (no accumulation). Best-effort — storage errors (quota / private mode) are ignored.
//
// A SECRET chat's draft is the exception: it is plaintext of an E2EE conversation, so it never goes to
// localStorage. It lives in this module's memory only (`persist: false`) and is lost on reload.
//
// In the Android app nothing goes to localStorage: the map lives in memory and its disk copy is one sealed
// record (features/chat/db, KV.drafts), restored at startup by hydrateDrafts.

import {kvSet, KV} from "@/features/chat/db/db.ts";
import {sealing} from "@/features/chat/db/sealed.ts";

export const DRAFTS_KEY = "wolp.drafts.v1";
const KEY = DRAFTS_KEY;
const MAX_DRAFTS = 300; // cap the map so it can't grow unbounded

/** Memory-only drafts (secret chats). Never serialized. */
const memory = new Map<string, string>();

// Android app: the persisted drafts, and whether the disk copy has been read (before that nothing is
// written, or a draft typed in the first second would replace the stored map).
let appMap: Record<string, string> = {};
let appReady = false;

function read(): Record<string, string> {
    if (sealing()) return appMap;
    try {
        const raw = localStorage.getItem(KEY);
        const obj = raw ? JSON.parse(raw) : null;
        return obj && typeof obj === "object" ? obj as Record<string, string> : {};
    } catch {
        return {};
    }
}

function write(map: Record<string, string>): void {
    if (sealing()) {
        appMap = map;
        if (appReady) void kvSet(KV.drafts, map).catch(() => { /* best-effort */ });
        return;
    }
    try {
        localStorage.setItem(KEY, JSON.stringify(map));
    } catch { /* quota / disabled → skip */ }
}

export function loadDraft(chatId: string): string {
    if (!chatId) return "";
    return memory.get(chatId) ?? read()[chatId] ?? "";
}

/**
 * Save (or, with empty text, remove) a chat's draft. `persist: false` keeps it in memory only and drops
 * any copy of this chat's draft already in localStorage — used for secret chats.
 */
export function saveDraft(chatId: string, text: string, opts?: {persist?: boolean}): void {
    if (!chatId) return;
    const persist = opts?.persist !== false;
    if (text && !persist) memory.set(chatId, text);
    else memory.delete(chatId);

    const map = read();
    if (text && persist) {
        map[chatId] = text;
        // Evict the oldest keys if we somehow exceed the cap (insertion order is preserved by JSON).
        const keys = Object.keys(map);
        for (let i = 0; i < keys.length - MAX_DRAFTS; i++) delete map[keys[i]];
    } else {
        if (!(chatId in map) && !persist) return;   // nothing on disk for this chat — don't touch storage
        delete map[chatId];
    }
    write(map);
}

export function clearDraft(chatId: string): void {
    saveDraft(chatId, "");
}

/** Android app, startup: the drafts read from the sealed record. What was typed meanwhile wins. */
export function hydrateDrafts(saved: Record<string, string> | null): void {
    appMap = {...(saved ?? {}), ...appMap};
    appReady = true;
}

export function clearAllDrafts(): void {
    memory.clear();
    appMap = {};   // the sealed record goes with clearAllLocalData
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/**
 * Move these chats' drafts out of localStorage into memory. Called at startup for the chats already in
 * secret mode and whenever a chat becomes secret, so a draft typed earlier doesn't stay on disk.
 */
export function dropPersistedDrafts(chatIds: string[]): void {
    if (!chatIds.length) return;
    const map = read();
    let changed = false;
    for (const id of chatIds) {
        if (!(id in map)) continue;
        if (!memory.has(id) && map[id]) memory.set(id, map[id]);
        delete map[id];
        changed = true;
    }
    if (changed) write(map);
}
