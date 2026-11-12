type WSStatus = "disconnected" | "connecting" | "connected"

export type WSMessage = {
    type: string;
    [key: string]: unknown;
}
export type WSDispatcher = (data: WSMessage) => void;

// WebRTC signalling wire types live HERE (the WS boundary), not in features/call — infrastructure is a
// lower layer and must not import UP into a feature. features/call re-exports these downward.
export type CallMedia = "audio" | "video";

// `callId` = one id per call attempt (caller-minted). It rides inside the opaque signaling body, so the
// backend relay never sees it. `call:ready` = "I opened from the call push, (re)send me the offer" — the
// callee sends it so the still-ringing caller re-offers and the callee gets a real INCOMING dialog.
// `sdp` = the SDP offer/answer ENCRYPTED end-to-end in the peers' Signal session (see webRTCService /
// e2ee secretChat). The relay only ever sees ciphertext, so it can't read or tamper with the DTLS
// `a=fingerprint` and can't MITM the media handshake. Never put a plaintext SDP on the wire.
export type IncomingWebRTCMessage =
    | WSMessage & { type: "call:offer"; from: string; sdp: string; media?: CallMedia; callId?: string; conversationId?: string }
    | WSMessage & { type: "call:answer"; from: string; sdp: string }
    | WSMessage & { type: "call:ice"; from: string; candidate: RTCIceCandidateInit }
    | WSMessage & { type: "call:ready"; from: string; callId?: string }
    | WSMessage & { type: "call:end"; from: string };

export type OutgoingWebRTCMessage =
    | { type: "call:offer"; to: string; sdp: string; media?: CallMedia; callId?: string }
    | { type: "call:answer"; to: string; sdp: string }
    | { type: "call:ice"; to: string; candidate: RTCIceCandidateInit }
    | { type: "call:ready"; to: string; callId?: string }
    | { type: "call:end"; to: string };

export type WebSocketState = {
    status: WSStatus;
    lastIncoming: IncomingWSMessage | null;
    lastOutgoing: OutgoingWSMessage | null;
    error: string | null;
    epoch: number;   // incremented on each (re)connect; used by the outbox for duplicate-safe resend
    // A newer session for this user (another tab/device) took over → the backend closed us with 4409
    // and we deliberately stopped auto-reconnecting. Distinct from a plain "disconnected" so the UI can
    // tell the user WHY they went offline and offer to take the session back here. Cleared on (re)connect.
    superseded: boolean;
};

// After the frameBridge, WebRTC signaling arrives as a `call:*` frame; everything else
// is a raw backend frame (CHAT_OUT, CHAT_ACK, READ_OUT, PRESENT_*, SYSTEM_OUT, ...).
export type IncomingWSMessage = IncomingWebRTCMessage | WSMessage;

export type OutgoingWSMessage = {
    type: string;
    [key: string]: unknown;
};
