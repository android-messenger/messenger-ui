import {buildReadIn, type WireMessage} from "@/features/chat/model/schema/wireMessage.schema.ts";
import {markChatUnread} from "@/features/chat/model/slices/chatUiSlice.ts";
import {chatOnScreen} from "@/features/chat/model/onScreen.ts";
import {notifyUser} from "./notify.ts";
import type {Incoming} from "./record.ts";
import type {IncomingStore} from "./types.ts";

/**
 * Step 5 of an incoming message — read or unread. The user is looking at the chat (onScreen.ts): it is read
 * up to this message, and the peer's ✓✓ moves to it (READ_IN with its server id). Otherwise the chat is
 * marked unread and the user is told (notify.ts); the read follows when the page is back (useReadReceipts).
 * A copy was counted and told with the first one.
 *
 * Nothing about the peer's reading is taken from an incoming message: a reply does not mean the peer read
 * my earlier messages (they can cross). That comes only from the history and from READ_OUT.
 */
export function markIncoming(store: IncomingStore, frame: WireMessage, m: Incoming): void {
    if (m.chatId === chatOnScreen(store.getState().chatUi?.selectedChatId)) {
        if (frame.senderId) store.dispatch({type: "ws/send", payload: buildReadIn(m.chatId, frame.senderId, frame.messageId)});
        return;
    }
    if (m.copy) return;
    store.dispatch(markChatUnread(m.chatId));
    notifyUser(m);
}
