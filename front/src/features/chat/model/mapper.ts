import {nanoid} from "@reduxjs/toolkit";
import type {ChatMessageView, OutboxMessage} from "@/features/chat/model/types.ts";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema.ts";
import {buildChatIn, type WireMessage} from "@/features/chat/model/schema/wireMessage.schema.ts";

type SendChatMessageCommand = {
    conversationId: string;
    recipientId: string;
    text: string;
    orderId?: string;
    /** Extra marks carried next to the text (e.g. `call: "missed"`). */
    meta?: Record<string, string>;
};

export function toChatMessageView(
    msg: ChatMessage,
    myId: string
): ChatMessageView {
    return {
        id: msg.id,
        fromMe: msg.from === myId,
        from: msg.from,
        text: msg.text,
        status: msg.status,
        createdAt: msg.createdAt.getTime(),
        kind: msg.kind,
        meta: msg.meta,
        secret: msg.secret,
        unsaved: msg.unsaved,
    };
}

/** Backend wire frame (CHAT_OUT / history row) → domain ChatMessage keyed by conversationId. */
export function wireToChatMessage(m: WireMessage): ChatMessage {
    const ts = m.serverTimestamp ?? m.senderTimestamp ?? Date.now();
    return {
        id: m.messageId ?? String(m.id ?? nanoid()),
        clientId: m.correlationId,   // sender's original client messageId (dedup key on live frames)
        chatId: m.conversationId ?? "",
        from: m.senderId ?? "",
        to: m.recipientId ?? "",
        text: m.payload?.body ?? "",
        createdAt: new Date(ts),
        status: "sent",
        kind: m.payload?.kind,
        meta: m.meta,
    };
}

/** A queued outgoing chat message: the CHAT_IN frame plus its client messageId (= outbox id). */
export function toOutboxMessage(cmd: SendChatMessageCommand): OutboxMessage {
    const messageId = nanoid();
    const marks = {...(cmd.meta ?? {}), ...(cmd.orderId ? { orderId: cmd.orderId } : {})};
    const meta = Object.keys(marks).length ? marks : undefined;
    return {
        id: messageId,
        idempotencyKey: messageId,
        status: "pending",
        attempts: 0,
        payload: buildChatIn({
            conversationId: cmd.conversationId,
            recipientId: cmd.recipientId,
            messageId,
            body: cmd.text,
            meta,
        }),
    };
}

