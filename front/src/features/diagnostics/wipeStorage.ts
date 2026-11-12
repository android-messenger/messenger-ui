import {logger} from "@/shared/logger/logger.ts";
import {E2EE_DATABASES} from "@/features/e2ee/lib/stores.ts";

// PANIC WIPE — the "erase everything on this device" action. Removes ALL client-side state this app ever
// wrote: every IndexedDB database (including the device/MASTER key, the Signal identity, sealed secret
// plaintext, recovery queue, and the media/history caches), all of localStorage and sessionStorage, every
// Cache Storage bucket (the PWA app-shell precache included), and the service worker. It is deliberately
// total — for the critical case where the device must be left holding nothing readable. The caller MUST
// hard-reload right after: on the next start, provisioning creates a FRESH device key from scratch, so the
// old secret history (its ratchet keys gone) is unrecoverable by design. Everything here is best-effort and
// never throws — a wipe must make progress even if one store is unavailable.

// Fallback list for browsers without indexedDB.databases() (Firefox). Keep in sync with the app's stores.
const KNOWN_DBS = [
    ...E2EE_DATABASES,      // device key, Signal identity + sessions, sealed plaintext, recovery queue
    "chatDB",               // outbox + per-chat history + media-attachment cache
    "wolp-names",        // directory name cache
    "wolp-pending-call", // a call awaiting pickup
    "wolp-push-dedup",   // cross-channel notification dedup (SW-owned, same origin)
];

function deleteDb(name: string): Promise<void> {
    return new Promise((resolve) => {
        try {
            const req = indexedDB.deleteDatabase(name);
            // onblocked = an open connection is still holding it; it completes once the page unloads on the
            // reload that follows. Resolve either way so the wipe never hangs.
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
        } catch { resolve(); }
    });
}

async function listDbNames(): Promise<string[]> {
    try {
        const enumerate = (indexedDB as {databases?: () => Promise<Array<{name?: string}>>}).databases;
        const found = enumerate ? (await enumerate.call(indexedDB)).map((d) => d.name).filter((n): n is string => !!n) : [];
        return Array.from(new Set([...found, ...KNOWN_DBS]));   // union: enumerated + known (belt and suspenders)
    } catch { return KNOWN_DBS; }
}

/** Erase every client-side store this app uses. Best-effort; never throws. Hard-reload afterwards. */
export async function wipeAllStorage(): Promise<void> {
    try { await Promise.all((await listDbNames()).map(deleteDb)); }
    catch (e) { logger.warn("wipe: indexedDB failed", e as Error); }

    try { localStorage.clear(); } catch { /* ignore */ }
    try { sessionStorage.clear(); } catch { /* ignore */ }

    try {
        if (typeof caches !== "undefined") {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
        }
    } catch { /* ignore */ }

    try {
        const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
        await Promise.all(regs.map((r) => r.unregister()));
    } catch { /* ignore */ }

    logger.info("wipe: all local storage cleared");
}
