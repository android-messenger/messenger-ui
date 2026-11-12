import {createAsyncThunk} from "@reduxjs/toolkit";
import {markSending, markFailed} from "../model/slices/outboxSlice.ts";
import type {RootState} from "@/store/store";
import {OUTBOX_RETRY_MAX_ATTEMPTS, OUTBOX_ACK_RESEND_MS} from "@/shared/config/outbox.ts";

// Push queued CHAT_IN frames over the WebSocket, DELIVERY-FIRST. Delivery is confirmed out-of-band by
// the server CHAT_ACK (correlationId === client messageId → markSent removes the row).
//
// Priority: NEVER LOSE a message, over avoiding a server-side duplicate. The previous "resend at most
// once per connection epoch" meant a send swallowed by a half-dead-but-still-"OPEN" socket was never
// re-sent until a reconnect → it could be lost outright. Now an un-ACKed message is RESENT every
// OUTBOX_ACK_RESEND_MS on the SAME connection, up to MAX_ATTEMPTS, then marked failed (⚠ + manual
// retry). The client messageId is STABLE across resends, so any duplicate this creates is collapsed
// client-side by client_message_id (dedupMessages + the middleware live-append) and eliminated at the
// source once the backend ingests idempotently by (conversation_id, client_message_id).
//
// Runs on enqueue, on (re)connect, and on a periodic tick (useOutboxRetry).
export const flushOutbox = createAsyncThunk<void, void, { state: RootState }>(
    "outbox/flush",
    async (_, {getState, dispatch}) => {
        const state = getState();
        if (state.ws.status !== "connected") return;
        const epoch = state.ws.epoch;

        const now = Date.now();
        for (const msg of state.outbox.messages) {
            if (msg.status === "sent" || msg.status === "failed") continue;

            // Sent recently and still within the ACK window — wait for the ACK, don't resend yet.
            if (
                msg.status === "sending" &&
                msg.lastAttemptAt !== undefined &&
                now - msg.lastAttemptAt < OUTBOX_ACK_RESEND_MS
            ) {
                continue;
            }

            // Out of retries — surface the failure (⚠ + manual retry) instead of resending forever.
            if (msg.attempts >= OUTBOX_RETRY_MAX_ATTEMPTS) {
                dispatch(markFailed(msg.id));
                continue;
            }

            // Send (pending) or RESEND (sending past the ACK window) — delivery-first.
            dispatch(markSending({id: msg.id, at: now, epoch}));
            dispatch({type: "ws/send", payload: msg.payload});
        }
    }
);
