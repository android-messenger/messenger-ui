import {isNativeApp} from "@/shared/platform.ts";
import {wrapBytes, unwrapBytes, type Wrapped} from "@/features/e2ee/wire.ts";

// The TEXT the interface keeps on disk outside secret chats — chat history, the send queue, drafts, the
// lists of chats, names — is encrypted in the Android app (plan F6, stage 5).
//
// Every record goes through the app's Vault (purpose `chat-cache`), the same way as the stored text of
// secret messages: the interface hands the bytes to the app and gets ciphertext back. The key stays in the
// app — no key of this cache ever reaches JavaScript — and the Vault is closed while the screen is locked.
// The place of a record (store and key) is written inside it and checked on reading, so a record moved to
// another place does not open.
//
// Attachments are NOT encrypted, in any chat (owner's decision 2026-11-13): their files are cached as they
// are; the app's private folder is what protects them.
//
// In a browser there is no Vault: records are stored as they were, in the clear. The browser client is for
// debugging and is going away.

const PURPOSE = "chat-cache";

/** How long a READ waits for the Vault (the phone may be locked, the app's start check may still run). After
 * that the read answers "nothing cached" and the caller goes to the network. A write waits as long as it takes. */
export const VAULT_WAIT_MS = 1_500;

/** A sealed record: a Vault blob. */
export type Sealed = Extract<Wrapped, {kind: "native"}>;

export function isSealed(x: unknown): x is Sealed {
    const r = x as Partial<Sealed> | null;
    return !!r && typeof r === "object" && r.kind === "native" && typeof r.blob === "string";
}

/** True where the disk copy is encrypted: inside the Android app only. */
export function sealing(): boolean {
    return isNativeApp();
}

const enc = new TextEncoder(), dec = new TextDecoder();

/** What is inside a sealed record: the value and the place it was written for. */
interface Inside { p: string; v: unknown }

/** The result of `call` if it comes within VAULT_WAIT_MS, else null. The call itself goes on and is ignored. */
async function soon<T>(call: Promise<T>): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    call.catch(() => { /* a late failure has no one to tell */ });
    try {
        return await Promise.race([
            call,
            new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), VAULT_WAIT_MS); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** What goes to disk for `value` (JSON-serializable): sealed in the app, the value itself in a browser. */
export async function toDisk(value: unknown, place: string): Promise<unknown> {
    if (!sealing()) return value;
    const inside: Inside = {p: place, v: value};
    return wrapBytes(enc.encode(JSON.stringify(inside)), PURPOSE);
}

/**
 * How a read of a record ended. The code that WRITES after a read must tell these apart:
 *  - `none`   — nothing is stored: start empty, writing is allowed;
 *  - `ok`     — read;
 *  - `gone`   — stored, and can never be read again: the Vault lost its key (the screen lock was removed)
 *               or the record is damaged. Start empty, writing is allowed — the old record is replaced;
 *  - `unread` — stored, not read THIS time: the Vault is closed, the app did not answer, the wait ran out.
 *               Nothing may be written over the record; the read is to be repeated.
 */
export type Read<T> = {state: "none"} | {state: "ok"; value: T} | {state: "gone"} | {state: "unread"};

const VAULT_KEY_GONE = "VAULT_KEY_GONE";
const VAULT_CORRUPT = "VAULT_CORRUPT";

/** Reads a record taken from disk. Never throws. A record of the other kind (an open one in the app, a
 * sealed one in a browser) counts as `none`; unless `wait`, a Vault that does not open within
 * VAULT_WAIT_MS is `unread`. */
export async function readDisk<T>(stored: unknown, place: string, opts?: {wait?: boolean}): Promise<Read<T>> {
    if (stored === undefined || stored === null) return {state: "none"};
    if (!sealing()) return isSealed(stored) ? {state: "none"} : {state: "ok", value: stored as T};
    if (!isSealed(stored)) return {state: "none"};
    let plain: ArrayBuffer | null;
    try {
        const call = unwrapBytes(stored, PURPOSE);
        plain = opts?.wait ? await call : await soon(call);
    } catch (e) {
        const code = (e as {code?: unknown} | null)?.code;
        return {state: code === VAULT_KEY_GONE || code === VAULT_CORRUPT ? "gone" : "unread"};
    }
    if (!plain) return {state: "unread"};
    try {
        const inside = JSON.parse(dec.decode(plain)) as Inside;
        return inside?.p === place ? {state: "ok", value: inside.v as T} : {state: "gone"};
    } catch {
        return {state: "gone"};   // opened, but not a record of ours
    }
}

/**
 * The value behind a record read from disk, or undefined when there is nothing readable (any outcome of
 * readDisk but `ok`). For a cache only: a caller that writes afterwards uses readDisk.
 */
export async function fromDisk<T>(stored: unknown, place: string, opts?: {wait?: boolean}): Promise<T | undefined> {
    const r = await readDisk<T>(stored, place, opts);
    return r.state === "ok" ? r.value : undefined;
}
