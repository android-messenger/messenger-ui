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
 * The value behind a record read from disk, or undefined when there is nothing readable: no record, a
 * record of the other kind (an open one in the app, a sealed one in a browser), a record from another
 * place, Vault keys that are gone, or — unless `wait` — a Vault that does not open within VAULT_WAIT_MS.
 */
export async function fromDisk<T>(stored: unknown, place: string, opts?: {wait?: boolean}): Promise<T | undefined> {
    if (stored === undefined || stored === null) return undefined;
    if (!sealing()) return isSealed(stored) ? undefined : stored as T;
    if (!isSealed(stored)) return undefined;
    try {
        const call = unwrapBytes(stored, PURPOSE);
        const plain = opts?.wait ? await call : await soon(call);
        if (!plain) return undefined;
        const inside = JSON.parse(dec.decode(plain)) as Inside;
        return inside?.p === place ? inside.v as T : undefined;
    } catch {
        return undefined;   // the Vault lost its keys, a damaged record, a sign-out while waiting
    }
}
