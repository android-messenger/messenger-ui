// ===========================
// Domain: Message
// ===========================

export type MessageId = string;

export type ChatMessageStatus =
    | "pending"
    | "sending"
    | "sent"
    | "failed";


// ===========================
// Outbox bd layer
// ===========================

// The queued outgoing message is the ready-to-send backend CHAT_IN frame.
import type {WireMessage} from "@/features/chat/model/schema/wireMessage.schema.ts";
export type OutboxMessagePayload = WireMessage;

export type OutboxMessage = {
    id: string;              // client messageId — echoed back as CHAT_ACK.correlationId
    idempotencyKey: string;
    payload: OutboxMessagePayload;
    status: ChatMessageStatus;
    attempts: number;         // how many send attempts so far (for the retry cap)
    lastAttemptAt?: number;   // epoch ms of the last send attempt (diagnostics)
    sentEpoch?: number;       // ws connection epoch it was last sent on (resend only in a newer epoch)
};

export type OutboxState = {
    messages: OutboxMessage[];
    outboxVersion: number;
    persistedVersion: number;
};


// ===========================
// Chat UI
// ===========================

export type ChatMessageView = {
    id: MessageId;
    fromMe: boolean;
    from: string;        // author (senderId) — labels the sender in a GROUP; ignored in 1:1
    text: string;
    status: ChatMessageStatus;
    createdAt: number;   // epoch ms — compared against the peer read watermark for per-message ✓✓
    kind?: string;
    meta?: Record<string, string>;
    secret?: boolean;    // travelled E2EE → show a 🔒 marker on the bubble
    unsaved?: boolean;   // secret text shown but NOT stored on this device (gone after a reload)
};

