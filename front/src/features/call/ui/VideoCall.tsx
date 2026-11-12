import {lazy, Suspense, useEffect, useRef, useState} from "react";
import {useSelector} from "react-redux";
import {useTranslation} from "react-i18next";
import {skipToken} from "@reduxjs/toolkit/query/react";
import type {RootState} from "@/store/store.ts";
import {idsDisplayName, useGetIdsUserQuery} from "@/features/directory";
import {computeSafetyNumber, isVerified} from "@/features/e2ee";
import ConfirmModal from "@/shared/ui/ConfirmModal.jsx";
import {NO_POSTER} from "@/shared/lib/noPoster.ts";
import {isNativeApp} from "@/shared/platform.ts";

// Android app only (S1 §4.5): sound route choice through the native Call plugin; never loaded in a browser.
const AudioRouteButton = lazy(() => import("@/infrastructure/native/AudioRouteButton.tsx"));
const routeButton = (className: string) => isNativeApp()
    ? <Suspense fallback={null}><AudioRouteButton className={className}/></Suspense>
    : null;

interface VideoCallProps {
    localStream: MediaStream | null;
    remoteStream: MediaStream | null;
    onHangUp: () => void;
    acceptCall: () => void;
    rejectCall: () => void;
}

export default function VideoCall({
                                      localStream,
                                      remoteStream,
                                      onHangUp,
                                      acceptCall,
                                      rejectCall,
                                  }: VideoCallProps) {
    const {t} = useTranslation();
    const localVideoRef = useRef<HTMLVideoElement>(null);
    const remoteVideoRef = useRef<HTMLVideoElement>(null);
    const remoteAudioRef = useRef<HTMLAudioElement>(null);

    const audioOnly = useSelector((state: RootState) => state.call.audioOnly);

    useEffect(() => {
        if (localVideoRef.current && localStream) {
            localVideoRef.current.srcObject = localStream;
        }
    }, [localStream]);

    useEffect(() => {
        // Attach the remote stream to whichever element is mounted for the current mode (video panel
        // for a video call, hidden audio element for a voice call) and explicitly start playback — the
        // stream arrives async (after the click that started the call), so the element doesn't always
        // autoplay on its own, which is heard as "no sound on the call".
        const el = audioOnly ? remoteAudioRef.current : remoteVideoRef.current;
        if (el && remoteStream) {
            el.srcObject = remoteStream;
            void el.play?.().catch(() => { /* autoplay policy may defer until a user gesture */ });
        }
    }, [remoteStream, audioOnly]);

    const callFrom = useSelector((state: RootState) => state.call.peerId);
    const callStatus = useSelector((state: RootState) => state.call.status);
    const myId = useSelector((state: RootState) => state.user?.id);

    // Every call is now E2EE-authenticated (the SDP rides the Signal session). Additionally reflect the
    // OUT-OF-BAND identity check: "verified" iff the peer's safety number is the one the user confirmed.
    // The answer is kept with the pair it was computed for, so a finished or changed call reads as "not
    // verified" without resetting state from the effect.
    const [verifiedPair, setVerifiedPair] = useState<string | null>(null);
    const pair = callFrom && myId ? `${myId}:${callFrom}` : null;
    useEffect(() => {
        let alive = true;
        if (!callFrom || !myId) return;
        const key = `${myId}:${callFrom}`;
        void computeSafetyNumber(myId, callFrom).then((n) => { if (alive) setVerifiedPair(isVerified(callFrom, n) ? key : null); });
        return () => { alive = false; };
    }, [callFrom, myId]);
    const peerVerified = pair !== null && verifiedPair === pair;
    const e2eeBadge = (
        <div className="text-xs text-teal-300/90">
            🔒 {t("call.encrypted", {defaultValue: "End-to-end encrypted"})}
            {peerVerified && <span className="ml-1 text-green-400">· ✓ {t("call.verified", {defaultValue: "verified"})}</span>}
        </div>
    );

    // Resolve the caller's display name by id (peerId is a user id) — no full-directory download.
    const {data: caller} = useGetIdsUserQuery(callFrom ?? skipToken);
    const callerName = caller ? idsDisplayName(caller) : (callFrom ?? "");

    // Show the incoming Accept/Reject dialog purely on status === "ringing". (Was gated behind a local
    // `newCall` useState that only reset on mount → if two calls batched so the status never rendered as
    // "idle" between them, VideoCall didn't remount, the flag stayed false, and the SECOND call showed no
    // dialog — the intermittent "через раз". Accepting moves status to "connecting", so this condition
    // closes on its own; the flag was redundant AND racy.)
    if (callStatus === "ringing") {
        return (
            <ConfirmModal
                title={t("call.incoming")}
                message={t("call.callingYou", {name: callerName})}
                confirmText={t("call.accept")}
                cancelText={t("call.reject")}
                onConfirm={() => {
                    acceptCall();
                }}
                onCancel={() => {
                    if (callFrom) {
                        rejectCall();
                    }
                }}
            />
        );
    }

    const statusLine = callStatus === "calling"
        ? t("call.calling", {name: callerName})
        : callStatus === "connecting" ? t("call.connecting") : null;

    if (audioOnly) {
        return (
            <div className="fixed inset-0 bg-teal-950 z-50 flex flex-col items-center justify-center text-white safe-area-pad">
                <div className="w-28 h-28 rounded-full bg-teal-800 flex items-center justify-center text-5xl font-semibold">
                    {(callerName || "?").charAt(0).toUpperCase()}
                </div>
                <div className="mt-5 text-2xl font-medium">{callerName}</div>
                <div className="mt-1 text-sm text-teal-300">🎙 {statusLine ?? t("call.audioCall")}</div>
                <div className="mt-1">{e2eeBadge}</div>
                {/* Remote audio (no video track in a voice call) */}
                <audio autoPlay playsInline ref={remoteAudioRef} className="hidden"/>
                {routeButton("absolute bottom-[calc(6.5rem+var(--wolp-sab))] left-1/2 -translate-x-1/2 flex flex-col items-center")}
                <button
                    onClick={onHangUp}
                    className="absolute bottom-[calc(2.5rem+var(--wolp-sab))] left-1/2 -translate-x-1/2 bg-red-600 text-white px-6 py-3 rounded-full hover:bg-red-700 transition-colors"
                >
                    {t("call.hangUp")}
                </button>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 bg-black z-50 flex safe-area-pad">
            <div className="absolute top-[calc(0.5rem+var(--wolp-sat))] inset-x-0 text-center z-10">{e2eeBadge}</div>
            {/* Who is on the call, for the whole call: an incoming call accepted from the native screen skips
                the "X is calling you" dialog, so without this a video call never named the peer. */}
            {callerName && (
                <div className="absolute top-[calc(2rem+var(--wolp-sat))] inset-x-0 text-center text-white text-xl font-medium z-10 drop-shadow">
                    {callerName}
                </div>
            )}
            {statusLine && (
                <div className="absolute top-[calc(4rem+var(--wolp-sat))] inset-x-0 text-center text-white text-lg z-10 drop-shadow">
                    {statusLine}
                </div>
            )}
            <video
                autoPlay
                muted
                playsInline
                poster={NO_POSTER}
                ref={localVideoRef}
                className="w-1/4 absolute bottom-[calc(1rem+var(--wolp-sab))] right-[calc(1rem+var(--wolp-sar))] rounded-lg bg-black"
            />
            <video
                autoPlay
                playsInline
                poster={NO_POSTER}
                ref={remoteVideoRef}
                className="w-full h-full object-cover bg-black"
            />
            {routeButton("absolute bottom-[calc(1.5rem+var(--wolp-sab))] left-[calc(1rem+var(--wolp-sal))] flex flex-col items-start z-10")}
            <button
                onClick={onHangUp}
                className="absolute bottom-[calc(1.5rem+var(--wolp-sab))] left-1/2 -translate-x-1/2 bg-red-600 text-white px-6 py-3 rounded-full hover:bg-red-700 transition-colors"
            >
                {t("call.hangUp")}
            </button>
        </div>
    );
}