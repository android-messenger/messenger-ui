// The WebRTC signalling wire types live in infrastructure (the WS boundary); re-exported here so call
// code keeps importing them from the feature. `media` = audio-only vs video (see infrastructure/types).
export type {CallMedia, IncomingWebRTCMessage, OutgoingWebRTCMessage} from "@/infrastructure/types.ts";
import type {CallMedia} from "@/infrastructure/types.ts";

type CallStatus = "idle" | "ringing" | "calling" | "connecting" | "in_call";

export interface CallState {
    status: CallStatus;
    peerId: string | null;
    offer: RTCSessionDescriptionInit | null;
}

// `sdp` = the E2EE-encrypted SDP (ciphertext); decrypted in webRTCService right before setRemoteDescription.
export type FromOffer = { from: string, sdp: string, media?: CallMedia, conversationId?: string }
export type FromAnswer = { from: string, sdp: string }
export type FromCandidate = { from: string, candidate: RTCIceCandidateInit }