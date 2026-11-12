import {openDB, type IDBPDatabase} from "idb";
import {E2EE_DB} from "./stores.ts";
import {deviceTrust, isNativeApp, push, removeListener, type PluginListenerHandle, type VaultPurpose} from "@/shared/platform.ts";

// The device wrapping key: a single NON-EXTRACTABLE AES-GCM CryptoKey, generated once and persisted in
// IndexedDB (structured-clone keeps a non-extractable CryptoKey intact — it can never be read back out as
// bytes, even by our own code). Every private key + every stored plaintext is encrypted under it, so the
// at-rest bytes are useless without a live handle to this key in this origin. This is the practical
// ceiling of PWA E2EE: a runtime-compromised origin can still use the key, but nothing on disk is readable.
//
// In the Android app (S1 §6) the same calls go to the native Vault instead (Android Keystore, S2 §9):
// the blob is {kind: "native", blob} and carries its purpose in the AEAD data, so an e2ee blob never
// unwraps as e2ee-plaintext. No WebCrypto device key is created in the app. A record without `kind`
// is the WebCrypto format (every record written before this change, and all browser records).

const STORE = "wrap";
const KEY = "deviceKey";

let dbp: Promise<IDBPDatabase> | null = null;
function db(): Promise<IDBPDatabase> {
    if (!dbp) {
        const p: Promise<IDBPDatabase> = openDB(E2EE_DB.device, 1, {
            upgrade(d) { if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE); },
            // A wipe (logout) asks to delete this database: let go at once, or the deletion stays blocked.
            blocking() { if (dbp === p) { dbp = null; keyp = null; } void p.then((d) => d.close(), () => {}); },
        });
        dbp = p;
    }
    return dbp;
}

let keyp: Promise<CryptoKey> | null = null;
/** Get-or-create the device wrapping key (memoized for the session). */
export function getDeviceKey(): Promise<CryptoKey> {
    if (!keyp) keyp = (async () => {
        const d = await db();
        const existing = (await d.get(STORE, KEY)) as CryptoKey | undefined;
        if (existing) {
            // Backfill createdAt for keys made before this field existed (so the info page has a value —
            // "first seen", approximate but stable).
            if (!(await d.get(STORE, "createdAt"))) await d.put(STORE, Date.now(), "createdAt");
            return existing;
        }
        const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false /* non-extractable */, ["encrypt", "decrypt"]);
        await d.put(STORE, key, KEY);
        await d.put(STORE, Date.now(), "createdAt");   // for the info page
        return key;
    })();
    return keyp;
}

/** When the device key was first generated (epoch ms), or 0 if not yet created. */
export async function getDeviceKeyCreatedAt(): Promise<number> {
    try { return ((await (await db()).get(STORE, "createdAt")) as number | undefined) ?? 0; } catch { return 0; }
}

/** WebCrypto-wrapped bytes (browser). `kind` is absent on every record written by a browser. */
export interface WebCryptoWrapped { kind?: "webcrypto"; iv: ArrayBuffer; ct: ArrayBuffer }
/** Vault-wrapped bytes (Android app): the native blob, base64. */
export interface NativeWrapped { kind: "native"; blob: string }
export type Wrapped = WebCryptoWrapped | NativeWrapped;

export function isNativeWrapped(w: Wrapped): w is NativeWrapped {
    return (w as NativeWrapped).kind === "native";
}

// Coerce any BufferSource (possibly from a cross-realm source — the crypto lib, or jsdom in tests) into a
// fresh same-realm Uint8Array, so WebCrypto's strict instanceof checks accept it.
function toBytes(src: BufferSource): Uint8Array {
    const view = ArrayBuffer.isView(src)
        ? new Uint8Array((src as ArrayBufferView).buffer, (src as ArrayBufferView).byteOffset, (src as ArrayBufferView).byteLength)
        : new Uint8Array(src as ArrayBuffer);
    return Uint8Array.from(view);
}

// VAULT_LOCKED (wolp-device-trust spec 001) is temporary and loses nothing: the E2EE half of the Vault
// opens only while the screen is unlocked, and only after this process's RASP pass found nothing blocking.
// So a native call that hits it waits and runs again — never treat it as lost keys (VAULT_KEY_GONE is
// that) and never clear E2EE data on it. A call can hit it while a call rings over the lock screen (the
// WebSocket stays open), and the answer must go out within seconds of the unlock: so wake on the page
// becoming visible again (MainActivity resumed after the unlock), on `appForeground`, or on a short poll
// (`appForeground` alone is not enough — it comes only after an `appBackground`).
export const VAULT_LOCKED = "VAULT_LOCKED";
export const VAULT_LOCKED_POLL_MS = 2_000;

let unlockWait: Promise<void> | null = null;
/** One shared wait for all locked calls. */
function waitForUnlock(): Promise<void> {
    if (!unlockWait) unlockWait = new Promise<void>((resolve) => {
        let handle: Promise<PluginListenerHandle> | PluginListenerHandle | null = null;
        let finished = false;
        const onVisible = () => { if (document.visibilityState === "visible") done(); };
        const done = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            removeListener(handle);
            if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
            unlockWait = null;
            resolve();
        };
        const timer = setTimeout(done, VAULT_LOCKED_POLL_MS);
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
        try { handle = push().addListener("appForeground", done); } catch { /* the poll still runs */ }
    });
    return unlockWait;
}

// A wait longer than this is shown to the user ("unlock the phone"): the Vault may also stay closed for a
// reason the wait cannot outlast (the app's integrity check closed it), and a silent "decrypting…" then
// looks like a hang.
export const VAULT_WAIT_NOTICE_MS = 5_000;
export const VAULT_WAIT_ABORTED = "VAULT_WAIT_ABORTED";

let waiting = 0;                 // calls currently waiting for the Vault to open
let longWait = false;            // at least one of them has waited longer than VAULT_WAIT_NOTICE_MS
let waitEpoch = 0;               // bumped by abortVaultWaits(): calls waiting since before it give up
const waitListeners = new Set<(long: boolean) => void>();
function setLongWait(v: boolean): void {
    if (longWait === v) return;
    longWait = v;
    for (const l of waitListeners) { try { l(v); } catch { /* a listener must not break a Vault call */ } }
}
/** True while some Vault call has been waiting for the unlock longer than VAULT_WAIT_NOTICE_MS. */
export function isVaultWaitLong(): boolean { return longWait; }
/** Subscribe to isVaultWaitLong() changes; returns the unsubscribe function. */
export function onVaultWait(listener: (long: boolean) => void): () => void {
    waitListeners.add(listener);
    return () => { waitListeners.delete(listener); };
}
/** Logout: calls waiting for the Vault stop with VAULT_WAIT_ABORTED instead of waiting forever. Nothing is erased here. */
export function abortVaultWaits(): void {
    waitEpoch++;
    setLongWait(false);
}

/** Runs a native Vault call, repeating it after VAULT_LOCKED until it succeeds, fails otherwise, or the
 * wait is aborted by logout. VAULT_LOCKED never clears E2EE data. */
async function vaultCall<T>(op: () => Promise<T>): Promise<T> {
    const epoch = waitEpoch;
    let since = 0;
    try {
        for (;;) {
            try {
                return await op();
            } catch (e) {
                if ((e as {code?: unknown} | null)?.code !== VAULT_LOCKED) throw e;
                if (!since) { since = Date.now(); waiting++; }
                await waitForUnlock();
                if (epoch !== waitEpoch) throw Object.assign(new Error("vault wait aborted"), {code: VAULT_WAIT_ABORTED});
                if (Date.now() - since >= VAULT_WAIT_NOTICE_MS) setLongWait(true);
            }
        }
    } finally {
        if (since && --waiting === 0) setLongWait(false);
    }
}

/** Encrypt arbitrary bytes under the device key (12-byte random IV) — or the native Vault in the app. */
export async function wrapBytes(plain: BufferSource, purpose: VaultPurpose = "e2ee"): Promise<Wrapped> {
    if (isNativeApp()) {
        const bytes = toBytes(plain);
        try {
            const data = b64(bytes.buffer as ArrayBuffer);
            const {blob} = await vaultCall(() => deviceTrust().vaultWrap({data, purpose}));
            return {kind: "native", blob};
        } finally {
            bytes.fill(0);
        }
    }
    const key = await getDeviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, toBytes(plain) as BufferSource);
    return { iv: iv.buffer, ct };
}

/** Decrypt bytes previously wrapped with wrapBytes (same purpose). */
export async function unwrapBytes(w: Wrapped, purpose: VaultPurpose = "e2ee"): Promise<ArrayBuffer> {
    if (isNativeWrapped(w)) {
        // A native blob outside the app (a copied profile) cannot be opened: the key is in the phone.
        const {data} = await vaultCall(() => deviceTrust().vaultUnwrap({blob: w.blob, purpose}));
        return unb64(data);
    }
    // The app never creates the WebCrypto key (S1 §12 п. 5); a WebCrypto record there is unreadable.
    if (isNativeApp()) throw new Error("WebCrypto-wrapped record in the Android app");
    const key = await getDeviceKey();
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(w.iv) }, key, w.ct);
}

/** Forget the in-memory handle of the device key (the wipe deletes the database itself). */
export function forgetDeviceKey(): void { keyp = null; }

/** Reset the device key (logout / wipe). Makes ALL wrapped material — keys and stored plaintext — permanently unreadable. */
export async function clearDeviceKey(): Promise<void> {
    keyp = null;
    try { const d = await db(); await d.delete(STORE, KEY); } catch { /* best-effort */ }
}

// --- base64 (std) for the directory wire format ---
export function b64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}
export function unb64(s: string): ArrayBuffer {
    const bin = atob(s); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}
