import {openDB, type IDBPDatabase} from "idb";

// A still-ringing incoming call, persisted by the Service Worker from a call push (see push-sw.js), so the
// app can pick it up when opened DIRECTLY — not only via the notification. Same DB/store/version on both
// sides. The original WebRTC offer is transient and gone by app-open, so the app uses this to re-run the
// answer flow (answerViaPush → caller re-offers → incoming dialog).

export interface PendingCall { conversationId: string; caller: string; media?: "audio" | "video"; at: number }

const DB = "wolp-pending-call";
const STORE = "call";
const KEY = "latest";

let dbp: Promise<IDBPDatabase> | null = null;
function db(): Promise<IDBPDatabase> {
    if (!dbp) dbp = openDB(DB, 1, { upgrade(d) { if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE); } });
    return dbp;
}

export async function readPendingCall(): Promise<PendingCall | null> {
    try { return ((await (await db()).get(STORE, KEY)) as PendingCall | undefined) ?? null; } catch { return null; }
}
export async function clearPendingCall(): Promise<void> {
    try { await (await db()).delete(STORE, KEY); } catch { /* best-effort */ }
}
