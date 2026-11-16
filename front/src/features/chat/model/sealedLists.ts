import toast from "react-hot-toast";
import i18n from "i18next";   // the instance shared/i18n sets up; not react-i18next (tests mock it)
import {sealing} from "@/features/chat/db/sealed.ts";
import type {DeliveryState} from "@/features/chat/model/slices/deliverySlice.ts";

// Android app: the list of secret chats, the sticky chats and the drafts are sealed records
// (features/chat/db), read after the start by the store (restoreSealed). The send queue is sealed too and
// is read after the sign-in (restoreOutbox). Until the read of the lists has ended — with
// "nothing stored", "read" or "the key is lost for good" — two things hold:
//  - nothing is SENT: whether a chat is secret is not known yet, and a message typed into a secret chat
//    would go out in the clear (audit 2026-11-13, U-1);
//  - none of these records is WRITTEN: what is in memory would replace what is stored.
// In a browser everything is read at once from localStorage: always ready.
//
// Whether they are read lives in the store (deliverySlice.listsReady, spec 003 FR-052). This module holds
// only the way to the store that is running — the store itself cannot be put into the store.

/** The line shown to the user when a send is refused because the lists are not read yet. */
const LISTS_NOT_READY_KEY = "chat.storageNotReady";

let current: (() => {delivery?: DeliveryState}) | null = null;

/** The store only (configureAppStore): the store whose lists are asked about from now on. */
export function bindLists(getState: () => {delivery?: DeliveryState}): void { current = getState; }

/** True once the sealed lists are in the store. */
export function listsReady(): boolean {
    return current?.().delivery?.listsReady ?? !sealing();
}

/**
 * "Can a message be sent now" — the one check before anything is put into the send queue or uploaded
 * (spec 003, FR-050). Refused: the user is told why and the typed text stays where it is.
 */
export function mayQueue(): boolean {
    if (listsReady()) return true;
    toast.error(i18n.t(LISTS_NOT_READY_KEY));
    return false;
}
