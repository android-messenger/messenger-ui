import {openDB, type IDBPDatabase} from "idb";
import {isNativeApp, push} from "@/shared/platform.ts";
import {kvGet, kvSet, KV} from "@/features/chat/db/db.ts";
import {sealing} from "@/features/chat/db/sealed.ts";

// A tiny PERSISTENT id→display-name store, separate from the media/history DB (no version coupling). The
// app writes it as the directory resolves; the SERVICE WORKER reads it (raw IndexedDB, see push-sw.js) to
// name Web Push notifications even when the app is CLOSED — the RTK-Query directory cache is in-memory
// only and gone once the page unloads. Same DB name + store + version 1 on both sides so whichever opens
// first creates the store. All best-effort — never throws into the caller.
//
// In the Android app there is no service worker and this database is not used: the names are one sealed
// record (KV.names), and native notifications take theirs from the app's own cache.
const DB = "wolp-names";
const STORE = "names";

let dbp: Promise<IDBPDatabase> | null = null;
function db(): Promise<IDBPDatabase> {
    if (!dbp) {
        dbp = openDB(DB, 1, {
            upgrade(d) { if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE); },
        });
    }
    return dbp;
}

// Android app (S1 §6): names for native notifications go to the Vault-backed cache through
// Push.updateContactNames — batched, at most once per NATIVE_NAMES_INTERVAL_MS.
const NATIVE_NAMES_INTERVAL_MS = 10_000;
let nativePending: Record<string, string> = {};
let nativeTimer: ReturnType<typeof setTimeout> | null = null;
let nativeLastSent = 0;
let sealedWrite: Promise<void> = Promise.resolve();

function flushNativeNames() {
    nativeTimer = null;
    const names = nativePending;
    nativePending = {};
    if (Object.keys(names).length === 0) return;
    nativeLastSent = Date.now();
    push().updateContactNames({names}).catch(() => { /* best-effort: notifications fall back to generic */ });
}

/** Queue names for the native cache (exported for tests). */
export function queueNativeNames(map: Record<string, string>, now: number = Date.now()): void {
    Object.assign(nativePending, map);
    if (nativeTimer) return;
    nativeTimer = setTimeout(flushNativeNames, Math.max(0, nativeLastSent + NATIVE_NAMES_INTERVAL_MS - now));
}

/** Persist id→name (only real names; empty/blank skipped). Best-effort. */
export async function saveNames(map: Record<string, string>): Promise<void> {
    try {
        const entries = Object.entries(map).filter(([id, name]) => id && name);
        if (entries.length === 0) return;
        if (isNativeApp()) queueNativeNames(Object.fromEntries(entries));
        if (sealing()) {
            // One writer at a time: each write starts from what the previous one stored.
            sealedWrite = sealedWrite.then(async () => {
                const all = {...((await kvGet<Record<string, string>>(KV.names, {wait: true})) ?? {}), ...Object.fromEntries(entries)};
                await kvSet(KV.names, all);
            }).catch(() => { /* best-effort */ });
            return;
        }
        const d = await db();
        const tx = d.transaction(STORE, "readwrite");
        for (const [id, name] of entries) tx.store.put(name, id);
        await tx.done;
    } catch { /* best-effort — names just fall back to generic in notifications */ }
}

/**
 * Read the whole id→name cache. Used to SEED the address book on a cold start: the chat list can render
 * real names instantly from this persistent cache while the IDS directory re-fetches in the background
 * (read-through), instead of briefly showing ids/emails. Best-effort — returns {} on any failure.
 */
export async function loadNames(): Promise<Record<string, string>> {
    try {
        if (sealing()) return (await kvGet<Record<string, string>>(KV.names)) ?? {};
        const d = await db();
        const keys = await d.getAllKeys(STORE);
        const vals = await d.getAll(STORE);
        const out: Record<string, string> = {};
        keys.forEach((k, i) => { if (typeof k === "string" && typeof vals[i] === "string") out[k] = vals[i] as string; });
        return out;
    } catch { return {}; }
}
