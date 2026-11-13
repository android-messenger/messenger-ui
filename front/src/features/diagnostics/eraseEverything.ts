import type {AppDispatch} from "@/store/store.ts";
import {fullLogout} from "@/features/auth/model/services/fullLogout.ts";
import {clearAllLocalData} from "@/features/chat/db/db.ts";
import {clearAllDrafts} from "@/features/chat/model/drafts.ts";
import {STICKY_KEY} from "@/features/chat/model/slices/stickyChatsSlice.ts";
import {wipeE2eeData} from "@/features/e2ee";
import {ERASE_PENDING_KEY, wipeAllStorage} from "./wipeStorage.ts";

/**
 * "Erase everything on this device" (the info page). The DEVICE first, the network after: the sign-out
 * steps wait for servers — up to ~16 s on a network that does not answer — and the user who pressed the
 * button may not have that long (audit 2026-11-13, F2).
 *
 *  1. A mark, so a start after an interruption finishes the job (store.ts, hydrateStore).
 *  2. What holds the user's text and files: the chat cache and the queue, the drafts, the lists, the
 *     stored texts of secret messages. No network.
 *  3. The sign-out: push registration, the keys in the app's library and their record in the key
 *     directory, the session. These need the network and the live session.
 *  4. Everything else the interface ever wrote, and the mark.
 * Never throws. The caller reloads the page afterwards.
 */
export async function eraseEverything(dispatch: AppDispatch): Promise<void> {
    try { localStorage.setItem(ERASE_PENDING_KEY, "1"); } catch { /* the erase goes on without the mark */ }
    await clearAllLocalData().catch(() => { /* best-effort */ });
    clearAllDrafts();
    try { localStorage.removeItem(STICKY_KEY); } catch { /* ignore */ }
    await wipeE2eeData();
    await fullLogout(dispatch);
    await wipeAllStorage();
}
