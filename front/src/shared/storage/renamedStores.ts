// The client's own stores carry the product prefix: "wolp.<name>" in localStorage, "wolp-<name>" in
// IndexedDB. Builds before the rename wrote the same stores under another prefix. Nothing is migrated —
// drafts and caches are rebuilt, the secret-chat list comes back from the history — but what the earlier
// build left behind is removed, so no stale copy of a draft or of the secret-chat list stays on the device.

const PREFIX = "wolp";

/** localStorage stores, by the part after "<prefix>.". */
export const LOCAL_STORES = ["drafts.v1", "secretChats", "e2eeVerified", "sticky-chats.v1", "e2eeWipePending", "e2eeNativeKeys", "cacheSealed"] as const;
/** IndexedDB stores, by the part after "<prefix>-". */
export const DB_STORES = ["names", "pending-call", "push-dedup", "cache-key"] as const;

const isLeftover = (name: string, sep: string, stores: readonly string[]) =>
    stores.some((s) => name.endsWith(sep + s) && name !== PREFIX + sep + s && name.indexOf(sep) === name.length - s.length - 1);

/** Remove what an earlier build stored under its own prefix. Best-effort; never throws. */
export async function sweepRenamedStores(): Promise<void> {
    try {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k) keys.push(k); }
        for (const k of keys) if (isLeftover(k, ".", LOCAL_STORES)) localStorage.removeItem(k);
    } catch { /* storage unavailable */ }
    try {
        const list = (indexedDB as {databases?: () => Promise<Array<{name?: string}>>}).databases;
        if (!list) return;
        const gone: Promise<void>[] = [];
        for (const d of await list.call(indexedDB)) {
            if (!d.name || !isLeftover(d.name, "-", DB_STORES)) continue;
            // Resolve on any outcome: a database still held open is deleted once it is released.
            gone.push(new Promise((resolve) => {
                const req = indexedDB.deleteDatabase(d.name!);
                req.onsuccess = req.onerror = req.onblocked = () => resolve();
            }));
        }
        await Promise.all(gone);
    } catch { /* not supported / blocked */ }
}
