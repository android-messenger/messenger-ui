import { z } from "zod";

export const ChatMessageStatusSchema = z.enum(["pending", "sending", "sent", "failed"]);

export const ChatMessageSchema = z.object({
    id: z.string().min(1),
    // Stable client-side dedup key = the sender's ORIGINAL client messageId, echoed by the backend
    // as correlationId on the live CHAT_OUT. Lets the receiver collapse a duplicate live delivery
    // (e.g. a lost-ACK resend) into one. Absent on history rows (backend doesn't persist it).
    clientId: z.string().optional(),
    chatId: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
    text: z.string().min(1),
    createdAt: z.preprocess(
        (val) => {
            if (typeof val === "string" || typeof val === "number") {
                return new Date(val);
            }
            return val;
        },
        z.date(),
    ),
    status: z.preprocess(() => "sent", ChatMessageStatusSchema),
    // payload.kind (e.g. "attachment") + opaque meta (attachmentId/fileName/contentType/…)
    kind: z.string().optional(),
    meta: z.record(z.string(), z.string()).optional(),
    // Set client-side when the message travelled E2EE (its wire body was a secret envelope). Drives the
    // 🔒 marker in the bubble; never comes from the server.
    // It is ALSO the "do not write to disk" flag: the history cache (features/chat/db/db.ts, toDiskRows)
    // drops rows with secret === true. Any code that puts DECRYPTED text into the getChatHistory cache
    // MUST set it — a decrypted row without the flag would be persisted in the clear.
    secret: z.boolean().optional(),
    unsaved: z.boolean().optional(),   // secret text shown but not stored on this device
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
