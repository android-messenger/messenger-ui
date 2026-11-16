import i18n from "@/shared/i18n";
import {logger} from "@/shared/logger/logger.ts";
import {chatApi} from "@/features/chat/rest/chatApi.ts";
import {groupApi} from "@/features/groups/rest/groupApi.ts";
import {chatMessagesService} from "@/features/chat/model/services/chatMessages.service.ts";
import {takenAt, wireToChatMessage} from "@/features/chat/model/mapper.ts";
import {socketRow} from "@/features/chat/model/slices/chatHistorySlice.ts";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema.ts";
import type {WireMessage} from "@/features/chat/model/schema/wireMessage.schema.ts";
import {isSecretEnvelope} from "@/features/e2ee/wire.ts";
import {ensureSecretChat} from "./secretText.ts";
import {isCopy} from "./copies.ts";
import type {IncomingStore} from "./types.ts";

/** A CHAT_OUT frame as the steps after the record see it. */
export interface Incoming {
    chatId: string;
    /** The row put into the chat. */
    row: ChatMessage;
    /** The sender: the frame's, else the message's. */
    sender: string;
    /** The sender as the frame names it — what the app and the service worker are given. */
    senderId: string | undefined;
    /** The envelope of a secret message, or null. The row shows "decrypting…" until its text is restored. */
    envelope: string | null;
    /** The same message of the peer again under another server id (copies.ts). */
    copy: boolean;
}

/**
 * Step 1 of an incoming message: into the chat (spec 003, FR-012) — before it is acknowledged. The slice
 * takes it if the chat's rows are in or are being read, on the screen or not; a chat never opened reads it
 * from the server when it is opened. One message is one row (historyCache.sameMessage): a lost-ACK resend
 * and an already-shown echo do not double. Null — the frame names no chat.
 */
export function recordIncoming(store: IncomingStore, frame: WireMessage): Incoming | null {
    const row = wireToChatMessage(frame);
    const chatId = row.chatId;
    if (!chatId) return null;
    // the frame's time is the time of this delivery; the row keeps the time the message was taken in
    row.createdAt = new Date(takenAt(row.id, row.createdAt.getTime()));

    // A secret message: the wire body is an opaque envelope. The row says "decrypting…" until the text is
    // restored (secretText.ts).
    const envelope = isSecretEnvelope(row.text) ? row.text : null;
    if (envelope) {
        row.text = i18n.t("chat.decrypting");
        row.secret = true;
        // The peer writes encrypted → the chat is secret on this side too, so the reply is encrypted.
        ensureSecretChat(store, chatId, true);
    }
    const sender = frame.senderId ?? row.from;
    const copy = isCopy(sender, row.clientId, row.id);
    store.dispatch(socketRow({chatId, row}));
    return {chatId, row, sender, senderId: frame.senderId, envelope, copy};
}

/**
 * A message in a chat that is in neither list (the first message from a new peer, a group I was just added
 * to): both lists are read again — the direct one through the helper that keeps a freshly created, still
 * hidden selected chat (a bare refetch would drop it and close the user's compose window).
 */
export function refreshListsIfUnknown(store: IncomingStore, chatId: string): void {
    const st = store.getState();
    const myId = st.user?.id as string;
    const inDirects = chatApi.endpoints.getChats.select({myId})(st)?.data?.some((s) => s.conversationId === chatId);
    const inGroups = groupApi.endpoints.getGroups.select(undefined)(st)?.data?.some((g) => g.id === chatId);
    if (inDirects || inGroups) return;
    logger.debug("CHAT_OUT for unknown conversation, refreshing chat lists", chatId);
    chatMessagesService.refetchChatsPreservingSelected(store.dispatch, store.getState);
    store.dispatch(groupApi.endpoints.getGroups.initiate(undefined, {forceRefetch: true}));
}
