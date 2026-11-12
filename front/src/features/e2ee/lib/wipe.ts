import {E2EE_DATABASES, E2EE_LOCAL_KEYS, E2EE_WIPE_PENDING_KEY} from "./stores.ts";
import {SignalStore} from "./signalStore.ts";
import {forgetDeviceKey, abortVaultWaits} from "./deviceKey.ts";
import {deleteSelf} from "./keyDirectory.ts";
import {logger} from "@/shared/logger/logger.ts";
import {deviceTrust, isNativeApp} from "@/shared/platform.ts";
import {forgetKeyChanges} from "./keyChange.ts";
import {E2EE_LS} from "./stores.ts";

// Logout wipe (spec 001, story 1; finding 13). After a logout the device holds no E2EE keys, no secret
// history and no marks: the next user of this device inherits nothing, and the same user who logs in
// again starts with a new key (owner's decision Q1 — wipe on EVERY logout).
//
// Nothing here decrypts anything, so a locked Vault (VAULT_LOCKED) cannot hold a logout up.

function lsGet(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key: string, value: string): void { try { localStorage.setItem(key, value); } catch { /* ignore */ } }
function lsRemove(key: string): void { try { localStorage.removeItem(key); } catch { /* ignore */ } }

/** Deletes one database. Resolves true when it is gone, false when it is not (yet): blocked or failed. */
function deleteDb(name: string): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
            // Another tab still holds a connection. The request stays queued and completes when that tab
            // lets go; do not wait for it — the pending mark makes the next start finish the job.
            req.onblocked = () => resolve(false);
        } catch { resolve(false); }
    });
}

/**
 * Erase everything secret chats keep on this device: the four E2EE databases and the E2EE localStorage
 * keys (lib/stores.ts). Never throws and never hangs. A mark is set before the first deletion and
 * removed only when every database is confirmed gone, so an interrupted or blocked wipe is finished by
 * finishPendingE2eeWipe() on the next start. The caller reloads the page afterwards (FR-004).
 */
export async function wipeE2eeData(): Promise<void> {
    lsSet(E2EE_WIPE_PENDING_KEY, "1");
    abortVaultWaits();   // nothing may keep waiting for the Vault across a logout
    forgetKeyChanges();
    forgetDeviceKey();
    let allGone = false;
    try {
        allGone = (await Promise.all(E2EE_DATABASES.map(deleteDb))).every(Boolean);
    } catch { /* treated as not finished */ }
    for (const key of E2EE_LOCAL_KEYS) lsRemove(key);
    if (allGone) lsRemove(E2EE_WIPE_PENDING_KEY);
    else logger.warn("e2ee wipe: not every database is gone yet; it is finished on the next start");
}

/** True while a wipe was started and not confirmed finished. */
export function e2eeWipePending(): boolean {
    return lsGet(E2EE_WIPE_PENDING_KEY) !== null;
}

/** Finishes a wipe that was interrupted (tab closed, app killed, database blocked). True if it ran. */
export async function finishPendingE2eeWipe(): Promise<boolean> {
    if (!e2eeWipePending()) return false;
    await wipeE2eeData();
    return true;
}

const DIRECTORY_TIMEOUT_MS = 4_000;
/** The app waits up to 4 s for the key directory itself; a logout never hangs on it. */
const NATIVE_WIPE_TIMEOUT_MS = 6_000;

/**
 * Sign-out, the part that needs the session. In the Android app: the app erases its keys and its record.
 * In a browser: remove this device's record from the key directory, so a peer gets "the recipient has no keys"
 * instead of encrypting to a key that is about to be erased. Call while the session is still valid and
 * BEFORE wipeE2eeData (the device id is read from the store). Best-effort: no record, 409 (a browser
 * asking to delete the phone's record), 401, an unreachable directory or a slow one never stop a logout.
 */
export async function removeFromKeyDirectory(): Promise<void> {
    // In the Android app the keys and the record are the app's library's: it erases the keys, sessions and
    // marks and removes the record itself (owner's decision: the keys are erased on every sign-out).
    if (isNativeApp()) {
        try {
            await Promise.race([
                deviceTrust().e2eeWipe(),
                new Promise<void>((resolve) => setTimeout(resolve, NATIVE_WIPE_TIMEOUT_MS)),
            ]);
        } catch (e) {
            logger.warn("e2ee: the app did not erase its keys on logout", e as Error);
        }
        return;
    }
    try {
        // The device id is stored in the clear; a device that never provisioned has nothing to remove.
        const deviceId = await new SignalStore().getDeviceId();
        if (!deviceId) return;
        await Promise.race([
            deleteSelf(deviceId),
            new Promise<void>((resolve) => setTimeout(resolve, DIRECTORY_TIMEOUT_MS)),
        ]);
    } catch (e) {
        logger.debug("e2ee: key directory record not removed on logout (best-effort)", e as Error);
    }
}

/**
 * Make sure the E2EE data on this device belongs to `userId` — before any key is read (FR-005, FR-006).
 * Finishes an interrupted wipe; erases data that carries another user's id; stamps unowned data (written
 * by a client version that had no owner field) with the current user instead of erasing it — otherwise
 * the update itself would cost every user their keys. Returns true if anything was wiped, so the caller
 * can drop its in-memory copy of the secret-chat set. Never throws.
 */
export async function ensureE2eeOwner(userId: string): Promise<boolean> {
    let wiped = false;
    try {
        wiped = await finishPendingE2eeWipe();
        const store = new SignalStore();
        const owner = await store.getOwner();
        if (owner !== undefined && owner !== userId) {
            logger.warn("e2ee: data of another user found on this device — erased");
            await wipeE2eeData();
            wiped = true;
        }
        if (wiped || owner === undefined) await new SignalStore().setOwner(userId);
    } catch (e) {
        logger.warn("e2ee: owner check failed", e as Error);
    }
    return wiped;
}

/** Set once the Android app's interface has dropped its own keys (FR-058). Not user data. */
export const E2EE_NATIVE_KEYS_KEY = "wolp.e2eeNativeKeys";

/**
 * The Android app, first start of the version whose keys live in the app's library (spec 001, FR-058):
 * the identity key, prekeys, sessions and remembered peers the interface used to keep are erased, and so
 * are its "verified" marks — the library keeps its own. Stored message texts stay. Runs once; a failure
 * is repeated on the next start. Never throws.
 */
export async function dropInterfaceKeys(): Promise<void> {
    if (!isNativeApp() || lsGet(E2EE_NATIVE_KEYS_KEY) !== null) return;
    try {
        await new SignalStore().dropKeys();
        lsRemove(E2EE_LS.verified);
        lsSet(E2EE_NATIVE_KEYS_KEY, "1");
        logger.info("e2ee: the interface's own keys are erased — the app's library holds the keys now");
    } catch (e) {
        logger.warn("e2ee: the interface's own keys were not erased; repeated on the next start", e as Error);
    }
}
