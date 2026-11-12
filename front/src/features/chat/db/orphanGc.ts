import {historyChatIds, deleteChatCache, pruneAttachmentIndex} from "./db.ts";
import {logger} from "@/shared/logger/logger.ts";

// Startup orphan sweep. Locally-cached chat data is meant to be purged when a chat is deleted, but that
// immediate cleanup can be missed (the server delete call failed, or the data predates the wiring). So once
// per session, after the authoritative chat list has loaded, we reconcile the RE-FETCHABLE caches against
// it and drop what no longer exists.
//
// IMPORTANT — it NO LONGER touches sealed secret plaintext. "Absent from the current list" is a
// FALSE-POSITIVE-prone signal (the backend hides message-less chats; groups/sticky merge late; a single
// stale/partial successful load happens) — and sealed plaintext is the ONLY copy of your OWN sent secret
// messages (encrypted to the peer on the server, unrecoverable). A false-positive sweep here destroyed a
// user's own messages ("Mensaje no disponible"). Sealed plaintext is now purged ONLY by an explicit chat
// delete (clearChatHistory → deletePlaintextForChat) and aged out by the 7-day retention TTL. History rows
// and attachment blobs stay swept-on-absence — they're harmless to drop (they re-download from the server).
//
// SAFETY: `liveIds` MUST be the COMPLETE current set of conversation ids from a SUCCESSFUL list load; the
// caller must not invoke this while the list is loading or errored. An empty set from a genuinely
// successful load (user has no chats) correctly purges the re-fetchable caches.

/** Purge cached history + attachment blobs for conversations not in `liveIds`. Never deletes sealed secret
 * plaintext (unrecoverable own-message copies — see above). */
export async function reconcileOrphanCaches(liveIds: Set<string>): Promise<{chats: number; index: number}> {
    let chats = 0, index = 0;
    try {
        for (const id of await historyChatIds()) {
            if (!liveIds.has(id)) { await deleteChatCache(id); chats++; }   // drops its history rows + attachment blobs
        }
        index = await pruneAttachmentIndex();   // repair byte-accounting drift from past deletes
        if (chats || index) logger.debug("orphan cache sweep", {chats, index});
    } catch (e) {
        logger.debug("orphan cache sweep skipped (best-effort)", e as Error);
    }
    return {chats, index};
}
