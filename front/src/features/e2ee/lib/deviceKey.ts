import {deviceTrust, isNativeApp, push, removeListener, type PluginListenerHandle, type VaultPurpose} from "@/shared/platform.ts";

// Wrapping of what the interface stores on the device: every call goes to the Android app's Vault
// (Android Keystore, S2 §9). The blob is {kind: "native", blob} and carries its purpose in the AEAD data,
// so a blob of one purpose never unwraps as another. Outside the app there is no key and nothing is
// wrapped: a browser stores no secret-chat data.
//
// A record without `kind` was written by a browser version that kept its own WebCrypto key. That key is
// gone; such a record is unreadable and is erased with the rest on logout.

/** A record of an older browser version (its own WebCrypto key): unreadable now. */
export interface WebCryptoWrapped { kind?: "webcrypto"; iv: ArrayBuffer; ct: ArrayBuffer }
/** Vault-wrapped bytes (Android app): the native blob, base64. */
export interface NativeWrapped { kind: "native"; blob: string }
export type Wrapped = WebCryptoWrapped | NativeWrapped;

export function isNativeWrapped(w: Wrapped): w is NativeWrapped {
    return (w as NativeWrapped).kind === "native";
}

// A private copy of the bytes: it is zeroed after the call, the caller's buffer is not touched.
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

/** What the app's secret-chat operations answer while the phone is locked: the same wait as VAULT_LOCKED. */
export const E2EE_LOCKED = "locked";

/** Runs a native Vault or secret-chat call, repeating it after VAULT_LOCKED / `locked` until it succeeds,
 * fails otherwise, or the wait is aborted by logout. A locked phone never clears E2EE data. */
export async function vaultCall<T>(op: () => Promise<T>): Promise<T> {
    const epoch = waitEpoch;
    let since = 0;
    try {
        for (;;) {
            try {
                return await op();
            } catch (e) {
                const code = (e as {code?: unknown} | null)?.code;
                if (code !== VAULT_LOCKED && code !== E2EE_LOCKED) throw e;
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

const NOT_IN_APP = "the Vault is only in the Android app";

/** Wrap bytes with the app's Vault. Throws outside the app. */
export async function wrapBytes(plain: BufferSource, purpose: VaultPurpose = "e2ee"): Promise<Wrapped> {
    if (!isNativeApp()) throw new Error(NOT_IN_APP);
    const bytes = toBytes(plain);
    try {
        const data = b64(bytes.buffer as ArrayBuffer);
        const {blob} = await vaultCall(() => deviceTrust().vaultWrap({data, purpose}));
        return {kind: "native", blob};
    } finally {
        bytes.fill(0);
    }
}

/** Unwrap bytes wrapped with wrapBytes (same purpose). Throws outside the app and on an old browser record. */
export async function unwrapBytes(w: Wrapped, purpose: VaultPurpose = "e2ee"): Promise<ArrayBuffer> {
    if (!isNativeApp()) throw new Error(NOT_IN_APP);
    if (!isNativeWrapped(w)) throw new Error("a record of an older browser version: unreadable");
    const {data} = await vaultCall(() => deviceTrust().vaultUnwrap({blob: w.blob, purpose}));
    return unb64(data);
}

// --- base64 (std): the bridge carries bytes as base64 ---
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
