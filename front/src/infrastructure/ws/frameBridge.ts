import type { IncomingWSMessage, OutgoingWSMessage, WSMessage } from "@/infrastructure/types.ts";

/**
 * WS boundary translator between this frontend's vocabulary and the messenger backend
 * wire protocol. Kept at the socket edge on purpose so that `features/call/*` and the
 * chat feature stay unaware of the backend frame shapes.
 *
 * WebRTC signaling: the frontend speaks `call:offer|answer|ice|end` with `to`/`from`;
 * the backend carries all of it in a single `SIGNAL_IN`/`SIGNAL_OUT` frame with the
 * sub-type in `payload.kind` and the WebRTC body JSON-encoded in `payload.body`.
 */

const CALL_PREFIX = "call:";
const E2EE_PREFIX = "e2ee:";   // E2EE recovery control frames ride the same opaque SIGNAL channel as calls

function uuid(): string {
    try { return crypto.randomUUID(); } catch { return "sig-" + Date.now() + "-" + Math.random().toString(36).slice(2); }
}

/** Outgoing: frontend action payload → backend inbound wire frame. */
export function toWire(outgoing: OutgoingWSMessage, ctx?: { conversationId?: string }): WSMessage {
    const frame = outgoing as WSMessage & { to?: string };

    if (typeof frame.type === "string" && (frame.type.startsWith(CALL_PREFIX) || frame.type.startsWith(E2EE_PREFIX))) {
        // Backend SIGNAL_IN validation REQUIRES: messageId, recipientId, conversationId,
        // senderTimestamp, senderTimezone, and payload.kind ∈ {text,attachment,event,custom}.
        // So the sub-type (call:offer/answer/ice/end, or e2ee:recover-req/resp) + its data go inside
        // payload.body under kind="event". `to` is the counterpart USER id. conversationId comes from the
        // frame itself (E2EE recovery carries the chatId) or, for calls, from wsMiddleware (ctx).
        const { type, to, conversationId, ...rest } = frame as WSMessage & { to?: string; conversationId?: string };
        return {
            type: "SIGNAL_IN",
            messageId: uuid(),
            recipientId: to,
            conversationId: conversationId ?? ctx?.conversationId,
            senderTimestamp: Date.now(),
            senderTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            payload: { kind: "event", body: JSON.stringify({ type, ...rest }) },
        };
    }

    // CHAT_IN / CHAT_ACK / READ_IN etc. are already built in backend shape upstream.
    return frame;
}

/** Incoming: backend outbound wire frame → frontend-shaped incoming message. */
export function fromWire(incoming: WSMessage): IncomingWSMessage {
    if (incoming?.type === "SIGNAL_OUT") {
        // payload.body carries { type: "call:offer"|..., offer|answer|candidate }
        const payload = (incoming.payload ?? {}) as { body?: string };
        const inner = payload.body ? JSON.parse(payload.body) : {};
        const from = (incoming.senderId as string) ?? (incoming.from as string);
        // Keep the frame's conversationId: the callee needs it to route its OWN answer/ice/end back, and
        // can't always derive it from the chat directory (an empty/never-opened conversation is hidden from
        // /api/chats). Without this, answering a caller you have no listed chat with silently no-ops.
        return { ...inner, from, conversationId: incoming.conversationId } as IncomingWSMessage;
    }

    return incoming as IncomingWSMessage;
}
