import {createAsyncThunk} from "@reduxjs/toolkit";
import {markSending, markFailed} from "../model/slices/outboxSlice.ts";
import type {RootState} from "@/store/store";
import {OUTBOX_RETRY_MAX_ATTEMPTS, OUTBOX_SEND_TIMEOUT_MS} from "@/shared/config/outbox.ts";

// Sends the queued CHAT_IN frames over the socket. The server confirms a message with a CHAT_ACK
// (correlationId === the client messageId), which takes it out of the queue.
//
// One frame per connection (spec 003, FR-030). The server does not yet join two frames of one client
// messageId into one message, so a second frame over the same connection is a second message and a second
// notification for the peer. A message with no confirmation is therefore:
//   - sent again once on every NEW connection, under the same client messageId;
//   - marked "not sent" when the connection it went over is alive and silent for OUTBOX_SEND_TIMEOUT_MS
//     (FR-031) — the user sees it and decides: "retry" (the same client messageId) or "discard";
//   - marked "not sent" after OUTBOX_RETRY_MAX_ATTEMPTS connections.
// A message that waits for a connection is never given up.
//
// Runs when a message is queued, on every connection, and on a timer (useOutboxRetry).
export const flushOutbox = createAsyncThunk<void, void, { state: RootState }>(
    "outbox/flush",
    async (_, {getState, dispatch}) => {
        const state = getState();
        if (state.ws.status !== "connected") return;
        const epoch = state.ws.epoch;

        const now = Date.now();
        for (const msg of state.outbox.messages) {
            if (msg.status === "sent" || msg.status === "failed") continue;

            // Already sent over this connection: wait for the confirmation, up to the limit.
            if (msg.status === "sending" && msg.sentEpoch === epoch) {
                if (msg.lastAttemptAt !== undefined && now - msg.lastAttemptAt >= OUTBOX_SEND_TIMEOUT_MS) {
                    dispatch(markFailed(msg.id));
                }
                continue;
            }

            if (msg.attempts >= OUTBOX_RETRY_MAX_ATTEMPTS) {
                dispatch(markFailed(msg.id));
                continue;
            }

            // Not sent yet, or sent over a connection that is gone.
            dispatch(markSending({id: msg.id, at: now, epoch}));
            dispatch({type: "ws/send", payload: msg.payload});
        }
    }
);
