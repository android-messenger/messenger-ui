import {getIceConfig} from "./iceConfig.ts";
import type {
    FromAnswer,
    FromCandidate,
    FromOffer,
    OutgoingWebRTCMessage
} from "@/features/call/model/types.ts";
import {logger} from "@/shared/logger/logger.ts";
import {secretCrypto} from "@/features/e2ee";
import {sendFailureKey} from "@/features/e2ee/wire.ts";
import toast from "react-hot-toast";
import i18n from "@/shared/i18n";

function uuid(): string {
    try { return crypto.randomUUID(); } catch { return "call-" + Date.now() + "-" + Math.random().toString(36).slice(2); }
}

// Cap the pre-offer ICE buffer so a flood of candidates before the offer arrives can't grow unbounded.
// A real call never queues anywhere near this many; past the cap we drop the oldest.
const MAX_PENDING_ICE = 100;

export class WebRTCService {
    /* ======================
       Private properties
    ====================== */
    private pc: RTCPeerConnection | null = null;
    private localStream: MediaStream | null = null;
    private remotePeerId: string | null = null;
    private pendingIce: RTCIceCandidateInit[] = [];
    private remoteReady: boolean = false;
    // One id per outgoing call attempt (caller-minted), carried in the offer so a re-offer to a callee
    // who joined late (from the call push) is recognizably the SAME call. Backend never sees it.
    private callId: string | null = null;
    // Audio-only (voice) call → init() opens the mic without a camera. Set per call by startCall (caller)
    // / handleOffer (callee) before init runs.
    private audioOnly: boolean = false;
    /** Bumped by every cleanup: an await that outlives a hang-up sees a new value and stops. */
    private generation = 0;

    /* ======================
       Callbacks for React state updates
    ====================== */
    private onLocalStreamChange?: (stream: MediaStream | null) => void;
    private onRemoteStreamChange?: (stream: MediaStream | null) => void;

    /* ======================
       Callback for sending WS messages
    ====================== */
    private sendWS?: (data: OutgoingWebRTCMessage) => void;

    /* ======================
       Callbacks to reflect the peer-connection lifecycle back into Redux
    ====================== */
    private onConnected?: () => void;
    private onEnded?: () => void;

    /* ======================
       Initialization
    ====================== */
    public setStreamCallbacks(
        onLocalStream: (stream: MediaStream | null) => void,
        onRemoteStream: (stream: MediaStream | null) => void
    ) {
        this.onLocalStreamChange = onLocalStream;
        this.onRemoteStreamChange = onRemoteStream;
    }

    public setSendCallback(send: (data: OutgoingWebRTCMessage) => void) {
        this.sendWS = send;
    }

    public setEventCallbacks(onConnected: () => void, onEnded: () => void) {
        this.onConnected = onConnected;
        this.onEnded = onEnded;
    }

    /* ======================
       WS send
    ====================== */
    private send(data: OutgoingWebRTCMessage) {
        this.sendWS?.(data);
    }

    /* ======================
       Error handler
    ====================== */
    private handleInitError(err: unknown) {
        logger.error("WebRTC init failed", err);

        toast.error(
            err instanceof DOMException
                ? err.message
                : i18n.t("call.startFailed")
        );

        this.cleanup();
    }

    /* ======================
       E2EE signaling failure (fail-closed): the SDP could not be end-to-end wrapped — usually the peer
       has published no keys. We NEVER fall back to a plaintext SDP (that would let the server force a
       downgrade + MITM), so the call is torn down and the user is told why.
    ====================== */
    private e2eeFail(err: unknown) {
        logger.warn("call: E2EE signaling failed — ending (no plaintext fallback)", err as Error);
        toast.error(i18n.t(sendFailureKey(err)));
        this.cleanup();
        this.onEnded?.();
    }

    /* ======================
       Cleanup
    ====================== */
    private cleanup() {
        this.generation++;
        this.remotePeerId = null;
        this.remoteReady = false;
        this.pendingIce = [];
        this.audioOnly = false;
        this.callId = null;

        this.pc?.close();
        this.pc = null;

        this.localStream?.getTracks().forEach(t => t.stop());
        this.localStream = null;

        this.onLocalStreamChange?.(null);
        this.onRemoteStreamChange?.(null);
    }

    /* ======================
       Init peer connection
    ====================== */
    private async init() {
        if (this.pc) return;

        // Acquire the mic/camera FIRST. If getUserMedia throws (permission denied, or the device is
        // momentarily busy right after recording/playing a voice note), no half-open pc is left set —
        // otherwise `this.pc` would stay non-null and every later call would silently no-op
        // (`if (this.pc) return`) until a page reload.
        const stream = await navigator.mediaDevices.getUserMedia({
            video: !this.audioOnly,
            audio: true,
        });

        const pc = new RTCPeerConnection(await getIceConfig());   // STUN + short-lived TURN creds (no static creds)
        this.pc = pc;
        this.localStream = stream;
        this.onLocalStreamChange?.(stream);

        stream.getTracks().forEach((t) => pc.addTrack(t, stream));

        pc.ontrack = (e) => {
            this.onRemoteStreamChange?.(e.streams[0]);
        };

        pc.onicecandidate = (e) => {
            if (!e.candidate || !this.remotePeerId) return;

            this.send({
                type: "call:ice",
                to: this.remotePeerId,
                candidate: e.candidate,
            });
        };

        // Reflect the connection lifecycle into Redux via callbacks (the service stays
        // framework-agnostic; store.ts wires these to dispatch).
        pc.onconnectionstatechange = () => {
            const s = pc.connectionState;
            if (s === "connected") {
                this.onConnected?.();
            } else if (s === "failed" || s === "closed") {
                // Terminal: release camera/mic + peer connection AND tell Redux, so the call UI
                // doesn't hang on a dead connection. "disconnected" is transient (ICE often
                // recovers), so we deliberately do NOT tear the call down on it.
                this.cleanup();
                this.onEnded?.();
            }
        };
    }

    /* ======================
       Start call (caller)
    ====================== */
    public async startCall(peerId: string, audioOnly: boolean = false) {
        if (this.pc) return;

        logger.debug(audioOnly ? "audio call starting with" : "video call starting with", peerId);

        this.audioOnly = audioOnly;
        this.remotePeerId = peerId;
        this.callId = uuid();

        try {
            await this.init();
        } catch (err) {
            this.handleInitError(err);
            throw err; // 🔥 Пробрасываем ошибку в middleware
        }

        if (!this.pc) return;

        const offer = await (this.pc as RTCPeerConnection).createOffer();
        await (this.pc as RTCPeerConnection).setLocalDescription(offer);

        let sdp: string;
        try { sdp = await secretCrypto.encrypt(peerId, JSON.stringify(offer)); }   // E2EE-authenticate the SDP/fingerprint
        catch (err) { this.e2eeFail(err); throw err; }

        this.send({
            type: "call:offer",
            to: peerId,
            sdp,
            media: audioOnly ? "audio" : "video",
            callId: this.callId ?? undefined,
        });
    }

    /* ======================
       Re-offer to the peer we're calling after they came online (call:ready). Used when the callee was
       offline, got the call push and opened the app. This MUST be an ICE RESTART, not a plain resend:
       our original ICE candidates were emitted (onicecandidate) right after the first offer, while the
       callee was still offline, so they're gone — the callee would get our SDP but NONE of our network
       candidates and the connection would never form. createOffer({iceRestart:true}) re-gathers, and
       onicecandidate re-fires the candidates, now delivered to the online callee. No-op if not mid-call.
    ====================== */
    public async resendOffer(): Promise<boolean> {
        if (!this.pc || !this.remotePeerId) return false;
        const offer = await this.pc.createOffer({iceRestart: true});
        await this.pc.setLocalDescription(offer);
        let sdp: string;
        try { sdp = await secretCrypto.encrypt(this.remotePeerId, JSON.stringify(offer)); }
        catch (err) { this.e2eeFail(err); return false; }
        this.send({
            type: "call:offer",
            to: this.remotePeerId,
            sdp,
            media: this.audioOnly ? "audio" : "video",
            callId: this.callId ?? undefined,
        });
        return true;
    }

    /* ======================
       Tell the caller "I'm here — (re)send the offer" after opening from a call push (callee side).
    ====================== */
    public signalReady(to: string, callId?: string) {
        this.send({type: "call:ready", to, callId});
    }

    /* ======================
       Handle offer (callee)
    ====================== */
    public async handleOffer({from, sdp, media}: FromOffer) {
        if (this.pc) {
            this.send({type: "call:end", to: from});
            throw new Error("Already in call");
        }

        // Match the caller's media choice so an audio call doesn't turn on our camera.
        this.audioOnly = media === "audio";
        logger.debug(this.audioOnly ? "audio call accepting offer" : "video call accepting offer");

        this.remotePeerId = from;

        // Decrypt the E2EE-wrapped SDP FIRST. Fail closed: a tampered/forged/undecryptable offer is
        // rejected outright — we never feed an unauthenticated SDP to setRemoteDescription (that's exactly
        // what a MITM would need). No camera/mic is opened for a bad offer either.
        // In the Android app the decrypt can wait for the screen unlock (VAULT_LOCKED, wolp-device-trust
        // spec 001); a call hung up or ended meanwhile must not be answered afterwards (zombie call).
        const gen = this.generation;
        let offer: RTCSessionDescriptionInit;
        try {
            offer = JSON.parse(await secretCrypto.decrypt(from, sdp)) as RTCSessionDescriptionInit;
        } catch (err) {
            if (gen !== this.generation) return;
            logger.warn("call: undecryptable offer — rejecting", err as Error);
            this.send({type: "call:end", to: from});
            this.cleanup();
            return;
        }
        if (gen !== this.generation) {
            logger.warn("call: offer decrypted after the call ended — dropped");
            return;
        }

        // Symmetric with startCall: if getUserMedia is denied or negotiation throws, tell the
        // caller, release everything and rethrow — otherwise a half-open pc + live camera track
        // would linger and wedge every future call for the session.
        try {
            await this.init();

            if (!this.pc) return;
            if (gen !== this.generation) {   // init's getUserMedia/TURN fetch outlived a hang-up
                this.cleanup();
                return;
            }

            await (this.pc as RTCPeerConnection).setRemoteDescription(offer);
            this.remoteReady = true;

            for (const c of this.pendingIce) {
                await (this.pc as RTCPeerConnection).addIceCandidate(c);
            }
            this.pendingIce = [];

            const answer = await (this.pc as RTCPeerConnection).createAnswer();
            await (this.pc as RTCPeerConnection).setLocalDescription(answer);

            const sdpA = await secretCrypto.encrypt(from, JSON.stringify(answer));   // E2EE-authenticate our answer SDP
            this.send({
                type: "call:answer",
                to: from,
                sdp: sdpA,
            });
        } catch (err) {
            this.send({type: "call:end", to: from});
            this.handleInitError(err);
            throw err;
        }
    }

    /* ======================
       Handle answer
    ====================== */
    public async handleAnswer({from, sdp}: FromAnswer) {
        if (!this.pc) return;
        if (this.pc.signalingState !== "have-local-offer") return;

        logger.debug("video call handling answer");

        // Decrypt the E2EE-wrapped answer; a tampered/undecryptable one ends the call (never applied raw).
        const gen = this.generation;
        let answer: RTCSessionDescriptionInit;
        try {
            answer = JSON.parse(await secretCrypto.decrypt(from, sdp)) as RTCSessionDescriptionInit;
        } catch (err) {
            if (gen !== this.generation) return;
            logger.warn("call: undecryptable answer — ending", err as Error);
            this.hangUp();
            return;
        }
        if (gen !== this.generation || !this.pc) return;   // ended while the decrypt waited

        this.remotePeerId = from;
        await this.pc.setRemoteDescription(answer);
        this.remoteReady = true;

        for (const c of this.pendingIce) {
            await this.pc.addIceCandidate(c);
        }
        this.pendingIce = [];
    }

    /* ======================
       Add ICE candidate
    ====================== */
    public async addIce({from, candidate}: FromCandidate) {
        if (!candidate) return;

        this.remotePeerId ??= from;

        if (!this.pc || !this.remoteReady) {
            if (this.pendingIce.length >= MAX_PENDING_ICE) this.pendingIce.shift();   // bounded buffer
            this.pendingIce.push(candidate);
            return;
        }

        await this.pc.addIceCandidate(candidate);
    }

    /* ======================
       Hang up
    ====================== */
    public hangUp() {
        if (this.remotePeerId) {
            this.send({
                type: "call:end",
                to: this.remotePeerId,
            });
        }
        this.cleanup();
    }

    /* ======================
       Reject call
    ====================== */
    public rejectCall(from: string) {
        this.send({type: "call:end", to: from});
        this.cleanup();
    }

    /* ======================
       Tear down on a REMOTE hangup: cleanup only, WITHOUT echoing call:end back — the peer already
       ended, so re-sending is a spurious signaling frame.
    ====================== */
    public endRemote() {
        this.cleanup();
    }

    /* ======================
       Decline someone else's incoming offer while already in a call: tell just that caller, and do
       NOT touch our live peer connection / streams (rejectCall's cleanup would kill the active call).
    ====================== */
    public declineOffer(to: string) {
        this.send({type: "call:end", to});
    }

    /* ======================
       Get connection state (for middleware)
    ====================== */
    public getConnectionState(): RTCPeerConnectionState | null {
        return this.pc?.connectionState ?? null;
    }
}

// 🔥 Singleton instance
export const webRTCService = new WebRTCService();