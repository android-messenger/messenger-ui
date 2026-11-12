import {openDB, type IDBPDatabase} from "idb";
import {E2EE_DB} from "../lib/stores.ts";

// Persistent set of secret messages awaiting client-to-client recovery (Step B). Persisted so a reload of
// the receiver doesn't lose in-flight recovery and falsely show "lost". Keyed by the SENDER's client id
// (nanoid / correlationId) — the only id both sides share and that the sender stored its plaintext under.

export interface PendingItem {
    clientId: string;     // correlation key across both sides (sender's nanoid)
    serverId: string;     // this row's server ULID here (where we render the recovered text)
    chatId: string;
    peerId: string;       // the sender we ask to re-send
    attempts: number;
    lastAt: number;       // last request time (backoff)
    createdAt: number;
}

const STORE = "pending";

let dbp: Promise<IDBPDatabase> | null = null;
function db(): Promise<IDBPDatabase> {
    if (!dbp) {
        const p: Promise<IDBPDatabase> = openDB(E2EE_DB.recovery, 1, {
            upgrade(d) { if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, {keyPath: "clientId"}); },
            // A wipe (logout) asks to delete this database: let go at once, or the deletion stays blocked.
            blocking() { if (dbp === p) dbp = null; void p.then((d) => d.close(), () => {}); },
        });
        dbp = p;
    }
    return dbp;
}

/** Add items not already pending (dedup by clientId). Returns the newly-added ones. */
export async function addPending(items: Omit<PendingItem, "attempts" | "lastAt" | "createdAt">[]): Promise<PendingItem[]> {
    const added: PendingItem[] = [];
    try {
        const d = await db();
        const tx = d.transaction(STORE, "readwrite");
        for (const it of items) {
            if (await tx.store.get(it.clientId)) continue;   // already pending
            const rec: PendingItem = {...it, attempts: 0, lastAt: 0, createdAt: Date.now()};
            await tx.store.put(rec);
            added.push(rec);
        }
        await tx.done;
    } catch { /* best-effort */ }
    return added;
}

export async function allPending(): Promise<PendingItem[]> {
    try { return (await (await db()).getAll(STORE)) as PendingItem[]; } catch { return []; }
}

export async function bumpAttempt(clientId: string): Promise<void> {
    try {
        const d = await db();
        const rec = (await d.get(STORE, clientId)) as PendingItem | undefined;
        if (rec) { rec.attempts += 1; rec.lastAt = Date.now(); await d.put(STORE, rec); }
    } catch { /* best-effort */ }
}

export async function removePending(clientId: string): Promise<void> {
    try { await (await db()).delete(STORE, clientId); } catch { /* best-effort */ }
}
