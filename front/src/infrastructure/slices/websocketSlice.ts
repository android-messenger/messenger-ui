import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type {IncomingWSMessage, OutgoingWSMessage, WebSocketState} from "../types.ts";
import {logger} from "@/shared/logger/logger.ts";

const initialState: WebSocketState = {
  status: "disconnected",
  lastIncoming: null,
  lastOutgoing: null,
  error: null,
  epoch: 0,
  superseded: false,
};

const websocketSlice = createSlice({
  name: "ws",
  initialState,
  reducers: {
    connecting(state) {
      state.status = "connecting";
      state.error = null;
      // Any (re)connect attempt clears the take-over state — we're no longer the yielded session.
      state.superseded = false;
    },

    connected(state) {
      state.status = "connected";
      state.error = null;
      state.superseded = false;
      // A new connection "epoch". The outbox resends an un-ACKed message at most once per epoch,
      // so a message already sent on the current (still-open) socket is NOT resent — that would
      // duplicate it, because the backend assigns its own messageId and does not dedupe by the
      // client messageId. Only a reconnect (new epoch) triggers a resend.
      state.epoch += 1;
    },

    disconnected(state) {
      state.status = "disconnected";
    },

    // Session take-over (backend 4409): another session for this user superseded us and we won't
    // auto-reconnect. Offline like "disconnected", but flagged so the banner explains it and offers
    // to reclaim the session here.
    superseded(state) {
      state.status = "disconnected";
      state.superseded = true;
    },

    incoming(state, action: PayloadAction<IncomingWSMessage>) {
      logger.debug("incoming ws ", JSON.stringify(action.payload));
      state.lastIncoming = action.payload;
    },

    outgoing(state, action: PayloadAction<OutgoingWSMessage>) {
      state.lastOutgoing = action.payload;
    },

    error(state, action: PayloadAction<string>) {
      state.error = action.payload;
    },

    clearIncoming(state) {
      state.lastIncoming = null;
    },

    clearOutgoing(state) {
      state.lastOutgoing = null;
    },
  },
});

export const {
  connecting,
  connected,
  disconnected,
  superseded,
  incoming,
  outgoing,
  error,
  clearIncoming,
  clearOutgoing,
} = websocketSlice.actions;

export default websocketSlice.reducer;
