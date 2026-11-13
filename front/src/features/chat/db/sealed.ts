import {openDB, type IDBPDatabase} from "idb";
import {isNativeApp} from "@/shared/platform.ts";
import {wrapBytes, unwrapBytes, type Wrapped} from "@/features/e2ee/wire.ts";

// What the interface keeps on disk outside secret chats — chat history, attachments, the send queue,
// drafts, the lists of chats, names — is encrypted in the Android app (plan F6, stage 5).
//
// One AES-256-GCM key for all of it. The key is made here, wrapped by the app's Vault (purpose
// `chat-cache`, a key in Android Keystore that works only while the screen is unlocked) and stored
// wrapped. It is unwrapped once per start and kept in memory as a non-extractable WebCrypto key, so a
// record is sealed and opened without a call to the app: a 50 MB video does not travel over the bridge.
// Each record is bound to its place (store and key) through the AEAD data, so a record moved to another
// place does not open.
//
// In a browser there is no Vault: records are stored as they were, in the clear. The browser client is for
// debugging and is going away.

const PURPOSE = "chat-cache";
export const CACHE_KEY_DB = "wolp-cache-key";
const STORE = "key";
const KEY = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** How long a READ waits for the key (the phone may be locked, the app's start check may still run). After
 * that the read answers "nothing cached" and the caller goes to the network. A write waits as long as it takes. */
export const KEY_WAIT_MS = 1_500;

/** A sealed record: AES-GCM with a fresh IV. */
export interface Sealed { s: 1; iv: Uint8Array<ArrayBuffer>; ct: ArrayBuffer }
/** A sealed attachment keeps its content type next to the bytes. */
export interface SealedBlob extends Sealed { type: string }

export function isSealed(x: unknown): x is Sealed {
    const r = x as Partial<Sealed> | null;
    // By shape, not by class: a record read back from IndexedDB may come from another realm.
    return !!r && typeof r === "object" && r.s === 1 && r.iv?.byteLength === IV_BYTES && typeof r.ct?.byteLength === "number";
}

/** True where the disk copy is encrypted: inside the Android app only. */
export function sealing(): boolean {
    return isNativeApp();
}

const enc = new TextEncoder(), dec = new TextDecoder();

let dbp: Promise<IDBPDatabase> | null = null;
function keyDb(): Promise<IDBPDatabase> {
    if (!dbp) {
        const p: Promise<IDBPDatabase> = openDB(CACHE_KEY_DB, 1, {
            upgrade(d) { if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE); },
            // A wipe asks to delete this database: let go at once, or the deletion stays blocked.
            blocking() { if (dbp === p) dbp = null; void p.then((d) => d.close(), () => {}); },
        });
        dbp = p;
    }
    return dbp;
}

/** The Vault says the wrapped key cannot be read again (keys destroyed, damaged record). Not "locked". */
function keyLost(e: unknown): boolean {
    const code = (e as {code?: unknown} | null)?.code;
    return code === "VAULT_KEY_GONE" || code === "VAULT_CORRUPT";
}

async function loadKey(): Promise<CryptoKey> {
    const d = await keyDb();
    const stored = (await d.get(STORE, KEY)) as Wrapped | undefined;
    let raw: Uint8Array<ArrayBuffer> | null = null;
    if (stored) {
        try { raw = new Uint8Array(await unwrapBytes(stored, PURPOSE)); }
        catch (e) { if (!keyLost(e)) throw e; }
    }
    if (!raw || raw.length !== KEY_BYTES) {
        // No key, or the Vault lost its own: a new key. What the old one sealed no longer opens and is
        // treated as absent — it is a cache, the server gives it again.
        raw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
        await d.put(STORE, await wrapBytes(raw, PURPOSE), KEY);
    }
    try {
        return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    } finally {
        raw.fill(0);
    }
}

let keyP: Promise<CryptoKey> | null = null;
/** The cache key; waits for the phone to be unlocked. Rejects outside the app. */
function key(): Promise<CryptoKey> {
    if (!keyP) {
        const p = loadKey();
        keyP = p;
        p.catch(() => { if (keyP === p) keyP = null; });   // a failed load is tried again on the next call
    }
    return keyP;
}

/** The key if it is there within KEY_WAIT_MS, else null. */
async function keySoon(): Promise<CryptoKey | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            key(),
            new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), KEY_WAIT_MS); }),
        ]);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** Sign-out: the next account gets its own key. The records themselves are erased by clearAllLocalData. */
export async function forgetCacheKey(): Promise<void> {
    keyP = null;
    try { await (await keyDb()).delete(STORE, KEY); } catch { /* best-effort */ }
}

async function seal(plain: BufferSource, place: string): Promise<Sealed> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = await crypto.subtle.encrypt({name: "AES-GCM", iv, additionalData: enc.encode(place)}, await key(), plain);
    return {s: 1, iv, ct};
}

async function open(rec: Sealed, place: string, wait: boolean): Promise<ArrayBuffer | undefined> {
    const k = wait ? await key() : await keySoon();
    if (!k) return undefined;
    try {
        return await crypto.subtle.decrypt({name: "AES-GCM", iv: rec.iv, additionalData: enc.encode(place)}, k, rec.ct);
    } catch {
        return undefined;   // sealed with a key that is gone, or moved from another place
    }
}

/** What goes to disk for `value` (JSON-serializable): sealed in the app, the value itself in a browser. */
export async function toDisk(value: unknown, place: string): Promise<unknown> {
    if (!sealing()) return value;
    return seal(enc.encode(JSON.stringify(value)), place);
}

/**
 * The value behind a record read from disk, or undefined when there is nothing readable: no record, a
 * record of the other kind (an open one in the app, a sealed one in a browser), a key that is gone, or —
 * unless `wait` — a key that is not there within KEY_WAIT_MS.
 */
export async function fromDisk<T>(stored: unknown, place: string, opts?: {wait?: boolean}): Promise<T | undefined> {
    if (stored === undefined || stored === null) return undefined;
    if (!sealing()) return isSealed(stored) ? undefined : stored as T;
    if (!isSealed(stored)) return undefined;
    const plain = await open(stored, place, opts?.wait === true);
    if (!plain) return undefined;
    try { return JSON.parse(dec.decode(plain)) as T; } catch { return undefined; }
}

function blobBytes(blob: Blob): Promise<ArrayBuffer> {
    if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
    return new Promise((resolve, reject) => {   // an environment without Blob.arrayBuffer (the tests' DOM)
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(blob);
    });
}

/** The same for an attachment file. */
export async function blobToDisk(blob: Blob, place: string): Promise<unknown> {
    if (!sealing()) return blob;
    const rec: SealedBlob = {...(await seal(await blobBytes(blob), place)), type: blob.type};
    return rec;
}

export async function blobFromDisk(stored: unknown, place: string): Promise<Blob | undefined> {
    if (stored === undefined || stored === null) return undefined;
    if (!sealing()) return isSealed(stored) ? undefined : stored as Blob;
    if (!isSealed(stored)) return undefined;
    const plain = await open(stored, place, false);
    return plain ? new Blob([plain], {type: (stored as SealedBlob).type || ""}) : undefined;
}

/** Bytes a stored record takes, for the info page. */
export function storedBytes(stored: unknown): number {
    if (isSealed(stored)) return stored.ct.byteLength;
    if (stored instanceof Blob) return stored.size;
    return (stored as {byteLength?: number} | null)?.byteLength ?? 0;
}
