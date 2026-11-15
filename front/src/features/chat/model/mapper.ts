import {ulidTimeMs} from "@/shared/ulid/ulid.ts";
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

/**
 * The moment the server took a message in. Its id is made at that moment and carries the time (a ULID);
 * the history gives the same time. The time in a frame from the socket is another one — the server
 * writes it anew at every attempt to deliver — so a row from the socket takes its time from the id, and
 * a read of the history does not move it (FR-018). `fallback` — for an id that is not the server's.
 */
export function takenAt<T extends number | undefined>(serverId: string | undefined | null, fallback: T): number | T {
    const t = ulidTimeMs(serverId);
    return Number.isNaN(t) ? fallback : t;
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

