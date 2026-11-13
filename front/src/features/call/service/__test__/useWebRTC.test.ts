import { describe, it, expect, vi, beforeEach } from "vitest";
import { webRTCService } from "../";
import type { OutgoingWebRTCMessage, FromOffer, FromAnswer, FromCandidate } from "@/features/call/model/types";

// ======================
// Mocks
// ======================

vi.mock("react-hot-toast", () => ({
    default: {
        error: vi.fn(),
    },
}));

// E2EE signaling: the service encrypts every SDP before sending and decrypts on receive. Mock with a
// reversible marker so we can assert the wire carries CIPHERTEXT (never a plaintext SDP) and round-trips.
vi.mock("@/features/e2ee", () => ({
    secretCrypto: {
        encrypt: vi.fn(async (_peer: string, text: string) => "ENC:" + text),
        decrypt: vi.fn(async (_from: string, body: string) => body.replace(/^ENC:/, "")),
    },
    fetchTurnCredentials: vi.fn(async () => ({username: "u", credential: "c", ttl: 600, uris: ["turn:x:3478?transport=udp"]})),
}));
import { secretCrypto } from "@/features/e2ee";
const encMock = vi.mocked(secretCrypto.encrypt);
const decMock = vi.mocked(secretCrypto.decrypt);
const enc = (o: unknown) => "ENC:" + JSON.stringify(o);

class MockRTCPeerConnection {
    static generateCertificate = vi.fn().mockResolvedValue({});

    connectionState = "new";
    signalingState: string = "stable";
    ontrack: ((ev: RTCTrackEvent) => void) | null = null;
    onicecandidate: ((ev: RTCPeerConnectionIceEvent) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;

    addTrack = vi.fn();
    createOffer = vi.fn().mockResolvedValue({ sdp: "offer-sdp", type: "offer" });
    setLocalDescription = vi.fn().mockResolvedValue(undefined);
    setRemoteDescription = vi.fn().mockResolvedValue(undefined);
    createAnswer = vi.fn().mockResolvedValue({ sdp: "answer-sdp", type: "answer" });
    addIceCandidate = vi.fn().mockResolvedValue(undefined);
    close = vi.fn();
}

(globalThis as unknown as { RTCPeerConnection: typeof MockRTCPeerConnection }).RTCPeerConnection =
    MockRTCPeerConnection;

Object.defineProperty(global.navigator, "mediaDevices", {
    value: {
        getUserMedia: vi.fn().mockResolvedValue({
            getTracks: () => [{ stop: vi.fn() }],
        }),
    },
});

// ======================
// Helper для сброса состояния singleton
// ======================
function resetService() {
    const service = webRTCService as unknown as {
        pc: RTCPeerConnection | null;
        localStream: MediaStream | null;
        remotePeerId: string | null;
        remoteReady: boolean;
        pendingIce: RTCIceCandidateInit[];
    };

    service.pc = null;
    service.localStream = null;
    service.remotePeerId = null;
    service.remoteReady = false;
    service.pendingIce = [];
}

// ======================
// Tests
// ======================

describe("WebRTCService", () => {
    let sendWS: (data: OutgoingWebRTCMessage) => void;
    let onLocalStream: (stream: MediaStream | null) => void;
    let onRemoteStream: (stream: MediaStream | null) => void;

    beforeEach(() => {
        resetService();

        sendWS = vi.fn<(data: OutgoingWebRTCMessage) => void>();
        onLocalStream = vi.fn<(stream: MediaStream | null) => void>();
        onRemoteStream = vi.fn<(stream: MediaStream | null) => void>();

        webRTCService.setSendCallback(sendWS);
        webRTCService.setStreamCallbacks(onLocalStream, onRemoteStream);

        vi.clearAllMocks();
        // Restore the reversible E2EE defaults after clearAllMocks (per-test overrides use *Once on top).
        encMock.mockImplementation(async (_peer: string, text: string) => "ENC:" + text);
        decMock.mockImplementation(async (_from: string, body: string) => body.replace(/^ENC:/, ""));
    });

    it("startCall — encrypts the offer SDP onto the wire (no plaintext)", async () => {
        await webRTCService.startCall("peer1");

        expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled();
        expect(sendWS).toHaveBeenCalledWith(expect.objectContaining({
            type: "call:offer",
            to: "peer1",
            sdp: enc({ sdp: "offer-sdp", type: "offer" }),   // ciphertext, not the raw SDP
            media: "video",
            callId: expect.any(String),
        }));
        expect(onLocalStream).toHaveBeenCalled();
    });

    it("startCall — fail-closed: encryption failure ends the call, no plaintext offer sent", async () => {
        encMock.mockRejectedValueOnce(Object.assign(new Error("e2ee encrypt refused"), {code: "no_device"}));
        await expect(webRTCService.startCall("peerNoKeys")).rejects.toThrow();
        const sentTypes = (sendWS as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as OutgoingWebRTCMessage).type);
        expect(sentTypes).not.toContain("call:offer");
    });

    it("handleOffer — call:end if already in a call", async () => {
        await webRTCService.startCall("peerX");
        const offer: FromOffer = { from: "peerY", sdp: enc({ sdp: "x", type: "offer" }) };
        await expect(webRTCService.handleOffer(offer)).rejects.toThrow("Already in call");
        expect(sendWS).toHaveBeenCalledWith({ type: "call:end", to: "peerY" });
    });

    it("handleOffer — decrypts the offer and sends an ENCRYPTED answer", async () => {
        const offer: FromOffer = { from: "peerY", sdp: enc({ sdp: "x", type: "offer" }) };
        await webRTCService.handleOffer(offer);

        expect(sendWS).toHaveBeenCalledWith({
            type: "call:answer",
            to: "peerY",
            sdp: enc({ sdp: "answer-sdp", type: "answer" }),
        });
    });

    it("handleOffer — a call ended while the decrypt waited (Vault locked) is not answered", async () => {
        let release!: (v: string) => void;
        decMock.mockImplementationOnce(() => new Promise<string>((r) => { release = r; }));
        const offer: FromOffer = { from: "peerY", sdp: enc({ sdp: "x", type: "offer" }) };
        const p = webRTCService.handleOffer(offer);
        webRTCService.rejectCall("peerY");                     // the user hangs up meanwhile
        release(JSON.stringify({ sdp: "x", type: "offer" }));  // the screen is unlocked later
        await p;

        const calls = (sendWS as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as OutgoingWebRTCMessage);
        expect(calls.some((m) => m.type === "call:answer")).toBe(false);
        expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
        expect((webRTCService as unknown as { pc: unknown }).pc).toBeNull();
    });

    it("handleOffer — fail-closed: an undecryptable offer is rejected, never setRemoteDescription'd", async () => {
        decMock.mockRejectedValueOnce(new Error("bad ciphertext"));
        const offer: FromOffer = { from: "peerY", sdp: "tampered" };
        await webRTCService.handleOffer(offer);

        const calls = (sendWS as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as OutgoingWebRTCMessage);
        expect(calls).toContainEqual({ type: "call:end", to: "peerY" });
        expect(calls.some((m) => m.type === "call:answer")).toBe(false);
        // init() is never reached for a bad offer → no peer connection was opened.
        expect((webRTCService as unknown as { pc: unknown }).pc).toBeNull();
    });

    it("handleAnswer — no-op if pc is absent", async () => {
        const answer: FromAnswer = { from: "peerZ", sdp: enc({ sdp: "a", type: "answer" }) };
        await webRTCService.handleAnswer(answer);
        expect(sendWS).not.toHaveBeenCalled();
    });

    it("handleAnswer — no-op if signalingState !== 'have-local-offer'", async () => {
        const pcMock = new MockRTCPeerConnection();
        (webRTCService as unknown as { pc: MockRTCPeerConnection }).pc = pcMock;
        pcMock.signalingState = "stable";

        const answer: FromAnswer = { from: "peerZ", sdp: enc({ sdp: "a", type: "answer" }) };
        await webRTCService.handleAnswer(answer);

        expect(sendWS).not.toHaveBeenCalled();
        expect(pcMock.setRemoteDescription).not.toHaveBeenCalled();
    });

    it("handleAnswer — decrypts and sets the remote description", async () => {
        await webRTCService.startCall("peer1");
        const pc = (webRTCService as unknown as { pc: MockRTCPeerConnection }).pc!;
        pc.signalingState = "have-local-offer";

        const answer: FromAnswer = { from: "peerZ", sdp: enc({ sdp: "a", type: "answer" }) };
        await webRTCService.handleAnswer(answer);

        expect(pc.setRemoteDescription).toHaveBeenCalledWith({ sdp: "a", type: "answer" });
    });

    it("addIce — queues into pendingIce while remoteReady = false", async () => {
        const candidate: FromCandidate = { from: "peer1", candidate: { candidate: "ice", sdpMid: "0", sdpMLineIndex: 0 } };
        await webRTCService.addIce(candidate);

        const service = webRTCService as unknown as { pendingIce: RTCIceCandidateInit[] };
        expect(service.pendingIce).toHaveLength(1);
    });

    it("addIce — calls pc.addIceCandidate when remoteReady = true", async () => {
        await webRTCService.startCall("peer1");
        const pc = (webRTCService as unknown as { pc: MockRTCPeerConnection }).pc!;
        (webRTCService as unknown as { remoteReady: boolean }).remoteReady = true;

        const candidate: FromCandidate = { from: "peer1", candidate: { candidate: "ice", sdpMid: "0", sdpMLineIndex: 0 } };
        await webRTCService.addIce(candidate);

        expect(pc.addIceCandidate).toHaveBeenCalledWith(candidate.candidate);
    });

    it("getConnectionState — returns the connection state", async () => {
        expect(webRTCService.getConnectionState()).toBeNull();

        await webRTCService.startCall("peer1");
        expect(webRTCService.getConnectionState()).toBe("new");
    });
});
