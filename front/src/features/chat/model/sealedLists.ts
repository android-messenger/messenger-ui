import {sealing} from "@/features/chat/db/sealed.ts";

// Android app: the list of secret chats, the sticky chats, the drafts and the send queue are sealed records
// (features/chat/db), read after the start by the store (restoreSealed). Until that read has ended — with
// "nothing stored", "read" or "the key is lost for good" — two things hold:
//  - nothing is SENT: whether a chat is secret is not known yet, and a message typed into a secret chat
//    would go out in the clear (audit 2026-11-13, U-1);
//  - none of these records is WRITTEN: what is in memory would replace what is stored.
// In a browser everything is read at once from localStorage: always ready.

let ready = !sealing();

/** True once the sealed lists are in the store. Every send checks it. */
export function listsReady(): boolean { return ready; }

/** The store only (restoreSealed, configureAppStore). */
export function setListsReady(value: boolean): void { ready = value; }

/** The line shown to the user when a send is refused because the lists are not read yet. */
export const LISTS_NOT_READY_KEY = "chat.storageNotReady";
