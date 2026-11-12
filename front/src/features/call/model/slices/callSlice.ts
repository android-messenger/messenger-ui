import {createSlice, type PayloadAction} from "@reduxjs/toolkit";
import type {CallMedia, FromOffer} from "@/features/call/model/types.ts";

type PendingPushAnswer = { peerId: string; conversationId: string; media?: CallMedia; autoAccept?: boolean };

const callSlice = createSlice({
  name: "call",
  initialState: {
    status: "idle" as "idle" | "ringing" | "calling" | "connecting" | "in_call",
    peerId: null as string | null,
    // Explicit conversationId for the outgoing call frame. Set only when we already know it (a call
    // deep-link from a push carries ?call=<conversationId>), so the frame doesn't depend on the chat
    // directory being loaded — otherwise a cold start from the notification races the getChats fetch.
    conversationId: null as string | null,
    // Deferred "answer from push": on a cold start the WS isn't open yet when we open from the call
    // notification, so we can't send call:ready immediately (ws/send drops frames on a closed socket).
    // Stash the intent here and let callMiddleware flush it once ws/connected fires.
    pendingPushAnswer: null as PendingPushAnswer | null,
    // Android app (S1 §7.3): the user accepted on the native incoming-call screen → the re-sent offer from
    // this peer is answered at once (callMiddleware). Cleared by that offer or any end of the call.
    autoAcceptFrom: null as string | null,
    incomingOfferData: null as FromOffer | null,
    // Current call is audio-only (voice) → the UI hides video and the service opens no camera.
    audioOnly: false,
  },
  reducers: {
    outgoingCall: (state, action: PayloadAction<{ peerId: string; audioOnly?: boolean; conversationId?: string }>) => {
      state.status = "calling";
      state.peerId = action.payload.peerId;
      state.conversationId = action.payload.conversationId ?? null;
      state.audioOnly = action.payload.audioOnly ?? false;
    },

    // Callee opened from a call push. Stash the conversationId (so the outgoing call:ready — and the
    // later answer/ice — route correctly even before getChats loads) but stay IDLE, so when the caller
    // re-offers we ring a real INCOMING dialog rather than auto-answering. The pending intent is flushed
    // by callMiddleware once the WS is connected (a cold start opens the socket only after this fires).
    answerViaPush: (state, action: PayloadAction<PendingPushAnswer>) => {
      state.conversationId = action.payload.conversationId;
      state.pendingPushAnswer = action.payload;
      state.autoAcceptFrom = action.payload.autoAccept ? action.payload.peerId : null;
    },

    // The pending push-answer has been sent (call:ready dispatched) — don't re-send on the next connect.
    pushAnswerFlushed: (state) => {
      state.pendingPushAnswer = null;
    },

    incomingOffer: (state, action: PayloadAction<FromOffer>) => {
      state.status = "ringing";
      state.peerId = action.payload.from;
      state.incomingOfferData = action.payload; // 🔥 сохраняем offer
      state.audioOnly = action.payload.media === "audio";
      // Store the conversationId the offer carried so our answer/ice/end route back even when this peer
      // isn't in the chat directory (empty conversations are hidden from /api/chats). Keep any explicit id
      // we already had (e.g. from a push deep-link) if the frame didn't include one.
      if (action.payload.conversationId) state.conversationId = action.payload.conversationId;
      state.pendingPushAnswer = null; // the caller's (re)offer arrived → no glare fallback needed
      state.autoAcceptFrom = null;
    },

    acceptCall: (state) => {
      state.status = "connecting";
    },

    incomingAnswer: (state) => {
      state.status = "connecting";
    },

    webrtcConnected: (state) => {
      state.status = "in_call";
    },

    incomingRemoteEnd: (state) => {
      state.status = "idle";
      state.peerId = null;
      // Keep conversationId through teardown: rejectCall/localEnd SEND a call:end AFTER this reducer runs,
      // and that frame needs the conversationId to route back to the peer (esp. a peer with no listed
      // chat). It's always overwritten when the next call starts (outgoingCall / answerViaPush /
      // incomingOffer), so a lingering value never leaks into a different call.
      state.pendingPushAnswer = null;
      state.incomingOfferData = null;
      state.autoAcceptFrom = null;
      state.audioOnly = false;
    },

    rejectCall: (state) => {
      state.status = "idle";
      state.peerId = null;
      // Keep conversationId through teardown: rejectCall/localEnd SEND a call:end AFTER this reducer runs,
      // and that frame needs the conversationId to route back to the peer (esp. a peer with no listed
      // chat). It's always overwritten when the next call starts (outgoingCall / answerViaPush /
      // incomingOffer), so a lingering value never leaks into a different call.
      state.pendingPushAnswer = null;
      state.incomingOfferData = null;
      state.autoAcceptFrom = null;
      state.audioOnly = false;
    },


    localEnd: (state) => {
      state.status = "idle";
      state.peerId = null;
      // Keep conversationId through teardown: rejectCall/localEnd SEND a call:end AFTER this reducer runs,
      // and that frame needs the conversationId to route back to the peer (esp. a peer with no listed
      // chat). It's always overwritten when the next call starts (outgoingCall / answerViaPush /
      // incomingOffer), so a lingering value never leaks into a different call.
      state.pendingPushAnswer = null;
      state.incomingOfferData = null;
      state.autoAcceptFrom = null;
      state.audioOnly = false;
    },
  },
});

export const {
  outgoingCall,
  answerViaPush,
  pushAnswerFlushed,
  incomingOffer,
  acceptCall,
  incomingAnswer,
  webrtcConnected,
  incomingRemoteEnd,
  localEnd,
  rejectCall
} = callSlice.actions;

export default callSlice.reducer;