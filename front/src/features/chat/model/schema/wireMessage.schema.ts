import { z } from "zod";

/**
 * The messenger backend wire frame (`Message`). Every WS frame and every history row is
 * one of these. We keep it permissive (`.passthrough()`) — the backend may add fields.
 */
export const WireMessageSchema = z
    .object({
        type: z.string(),
        id: z.number().optional(),            // outbox row id → becomes ackId on CHAT_ACK
        ackId: z.number().optional(),
        senderId: z.string().optional(),
        recipientId: z.string().optional(),
        conversationId: z.string().optional(),
        messageId: z.string().optional(),     // server-assigned ULID (dedup + history cursor)
        serverMessageId: z.string().optional(), // on CHAT_ACK: the STORED message's ULID (vs messageId = the ack frame's own id)
        correlationId: z.string().optional(),
        senderTimestamp: z.number().optional(),
        senderTimezone: z.string().optional(),
        serverTimestamp: z.number().optional(),
        sequenceNumber: z.number().optional(),
        payload: z
            .object({ kind: z.string().optional(), body: z.string().optional() })
            .passthrough()
            .optional(),
        meta: z.record(z.string(), z.string()).optional(),
    })
    .passthrough();

export type WireMessage = z.infer<typeof WireMessageSchema>;

export function parseWireMessage(data: unknown): WireMessage | null {
    const r = WireMessageSchema.safeParse(data);
    return r.success ? r.data : null;
}

/**
 * Build a `CHAT_IN` frame. The server overwrites `senderId` from the session identity. `recipientId`
 * is OMITTED when empty: a GROUP send carries only the conversationId (the server fans out to the
 * roster and ignores recipientId) — sending an empty string could trip inbound validation.
 */
export function buildChatIn(p: {
    conversationId: string;
    recipientId?: string;
    messageId: string;
    body: string;
    meta?: Record<string, string>;
}): WireMessage {
    return {
        type: "CHAT_IN",
        conversationId: p.conversationId,
        ...(p.recipientId ? { recipientId: p.recipientId } : {}),
        messageId: p.messageId,
        senderTimestamp: Date.now(),
        senderTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        payload: { kind: "text", body: p.body },
        ...(p.meta ? { meta: p.meta } : {}),
    };
}

function newId(): string {
    try { return crypto.randomUUID(); } catch { return "id-" + Date.now() + "-" + Math.random().toString(36).slice(2); }
}
function tz(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone; }

/**
 * Acknowledge a delivered `CHAT_OUT` (SENT → DELIVERED; advances the GC watermark).
 * The backend validates ALL inbound frames, so an ACK needs the full id set + timestamp, not just
 * correlationId/ackId — otherwise it is silently rejected and the message is redelivered forever.
 */
export function buildChatAck(delivered: WireMessage): WireMessage {
    return {
        type: "CHAT_ACK",
        messageId: newId(),
        recipientId: delivered.senderId,        // the ACK goes back to the original sender
        conversationId: delivered.conversationId,
        correlationId: delivered.messageId,     // the delivered server message id
        ackId: delivered.id,                    // outbox row id (advances the watermark)
        senderTimestamp: Date.now(),
        senderTimezone: tz(),
    };
}

/**
 * Read receipt: advance this side's read watermark. Per the backend contract, the boundary rides in
 * `correlationId` = the largest SERVER messageId the reader has rendered (from CHAT_OUT.messageId or
 * history) — a server ULID only, monotonic (forward-only, enforced server-side). `messageId` is just
 * the frame's own event id. The peer then reads this back as `peerLastReadId` on GET /messages.
 */
export function buildReadIn(conversationId: string, recipientId?: string, lastReadMessageId?: string): WireMessage {
    return {
        type: "READ_IN",
        messageId: newId(),                  // the frame's own event id (not the boundary)
        correlationId: lastReadMessageId,     // ← the read boundary (largest rendered server ULID)
        ...(recipientId ? { recipientId } : {}),
        conversationId,
        senderTimestamp: Date.now(),
        senderTimezone: tz(),
    };
}

/** Typing indicator (Strategy S; delivered live as TYPING_OUT, never stored). Needs a valid payload.
 *  `recipientId` is omitted for a GROUP (fanned out to the roster; conversationId is enough). */
export function buildTypingIn(conversationId: string, recipientId?: string): WireMessage {
    return {
        type: "TYPING_IN",
        messageId: newId(),
        ...(recipientId ? { recipientId } : {}),
        conversationId,
        senderTimestamp: Date.now(),
        senderTimezone: tz(),
        payload: { kind: "event", body: "typing" },
    };
}
