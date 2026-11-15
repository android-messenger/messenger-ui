import {createSlice, type PayloadAction} from "@reduxjs/toolkit";
import type {OutboxMessage, OutboxState} from "@/features/chat/model/types.ts";
import {logger} from "@/shared/logger/logger.ts";

const initialState: OutboxState = {
    messages: [],
    outboxVersion: 0,
    persistedVersion: 0,
    restored: false,
};

function bumpVersion() {
    return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

const outboxSlice = createSlice({
    name: "outbox",
    initialState,
    reducers: {
        // The stored queue is read after the owner of the device is known (and, in the Android app, after
        // the phone is unlocked), so messages may have been queued meanwhile. The stored ones go first;
        // nothing already in the queue is replaced (FR-025). `null` — nothing is stored.
        mergeOutbox(state, action: PayloadAction<Pick<OutboxState, "messages"> | null>) {
            state.restored = true;
            const have = new Set(state.messages.map((m) => m.id));
            // A stored message that was on its way went over a connection of the start before: the numbers of
            // the connections begin anew, so it is "not sent yet" here and goes out on the first connection.
            const stored = (action.payload?.messages ?? []).filter((m) => !have.has(m.id))
                .map((m) => (m.status === "sending" ? {...m, status: "pending" as const, sentEpoch: undefined} : m));
            if (stored.length === 0) return;
            state.messages = [...stored, ...state.messages];
            state.outboxVersion = bumpVersion();
        },

        // Sign-out, or another account on this device: no message of the queue may be sent under the next
        // session. The disk is erased by the caller; the queue is read again at the next sign-in.
        // The end of a session (a 401) is NOT this: the same user signs in again to the same queue (FR-020).
        clearOutbox(state) {
            state.messages = [];
            state.restored = false;
            state.outboxVersion = bumpVersion();
        },

        enqueueMessage(state, action: PayloadAction<Omit<OutboxMessage, "status" | "attempts">>) {
            logger.debug("message added ", action.payload);
            state.messages.push({
                ...action.payload,
                status: "pending",
                attempts: 0,
            });
            state.outboxVersion = bumpVersion();
        },

        // The message has gone out: over which connection (one frame per connection) and when (the wait
        // for a confirmation is measured from here).
        markSending(state, action: PayloadAction<{ id: string; at: number; epoch: number }>) {
            const msg = state.messages.find(m => m.id === action.payload.id);
            if (msg) {
                msg.status = "sending";
                msg.attempts += 1;
                msg.lastAttemptAt = action.payload.at;
                msg.sentEpoch = action.payload.epoch;
            }
        },

        markSent(state, action: PayloadAction<string>) {
            logger.debug("message sent ", action.payload);
            state.messages = state.messages.filter(m => m.id !== action.payload);
            state.outboxVersion = bumpVersion();
        },

        markFailed(state, action: PayloadAction<string>) {
            logger.debug("sent failed", action.payload);
            const msg = state.messages.find(m => m.id === action.payload);
            if (msg) msg.status = "failed";
            state.outboxVersion = bumpVersion();
        },

        // User-driven "retry" of a failed message: reset it so the sender re-picks it up.
        retryMessage(state, action: PayloadAction<string>) {
            const msg = state.messages.find(m => m.id === action.payload);
            if (msg) {
                msg.status = "pending";
                msg.attempts = 0;
                msg.sentEpoch = undefined;
            }
            state.outboxVersion = bumpVersion();
        },

        // User-driven "discard" of a queued/failed message: drop it from the outbox entirely.
        discardMessage(state, action: PayloadAction<string>) {
            state.messages = state.messages.filter(m => m.id !== action.payload);
            state.outboxVersion = bumpVersion();
        },

        // Record the version that was ACTUALLY written, passed by the saver — NOT the live
        // outboxVersion. If a new message bumped the version during the async IndexedDB write, reading
        // it live here would mark that newer (unsaved) version persisted and the saver would skip it,
        // losing the message from disk.
        markPersisted(state, action: PayloadAction<number>) {
            logger.debug("storage persisted", action.payload);
            state.persistedVersion = action.payload;
        },
    },
});

export const {
    mergeOutbox,
    clearOutbox,
    enqueueMessage,
    markSending,
    markSent,
    markFailed,
    markPersisted,
    retryMessage,
    discardMessage,
} = outboxSlice.actions;

export default outboxSlice.reducer;