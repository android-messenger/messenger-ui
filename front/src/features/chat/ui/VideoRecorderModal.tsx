import {useCallback, useEffect, useRef} from "react";
import {useTranslation} from "react-i18next";
import {useVideoRecorder} from "@/features/chat/hooks/useVideoRecorder.ts";
import {NO_POSTER} from "@/shared/lib/noPoster.ts";
import {VIDEO_MAX_DURATION_MS, VIDEO_CAPTURE_MAX_BYTES} from "@/shared/config/chat.ts";

function formatMs(ms: number): string {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Full-screen camera modal for recording a video message. Opens the camera for a live preview on mount,
 * records on tap, and hands the clip to onSend. Cancelling or an auto-stop at VIDEO_MAX_DURATION_MS both
 * release the camera. The preview is mirrored (selfie) but the recorded file is not.
 */
export function VideoRecorderModal({onSend, onClose}: {onSend: (file: File) => void; onClose: () => void}) {
    const {t} = useTranslation();
    const {stream, recording, elapsedMs, bytes, open, start, stop, close} = useVideoRecorder();
    const videoRef = useRef<HTMLVideoElement>(null);

    // Acquire the camera on mount; if it fails (permission/denied) the hook toasts — close the modal.
    useEffect(() => {
        let alive = true;
        open().then((ok) => { if (alive && !ok) onClose(); });
        return () => { alive = false; };
    }, [open, onClose]);

    useEffect(() => {
        if (videoRef.current && stream) videoRef.current.srcObject = stream;
    }, [stream]);

    const cancel = useCallback(() => { close(); onClose(); }, [close, onClose]);
    const finish = useCallback(async () => {
        const file = await stop();
        close();
        if (file) onSend(file);
        onClose();
    }, [stop, close, onSend, onClose]);

    // Auto-stop + send at the max length OR the size budget (whichever first) — so a recorded clip can
    // never exceed the send limit and get rejected AT send (some devices ignore the bitrate cap).
    useEffect(() => {
        if (recording && (elapsedMs >= VIDEO_MAX_DURATION_MS || bytes >= VIDEO_CAPTURE_MAX_BYTES)) void finish();
    }, [recording, elapsedMs, bytes, finish]);

    return (
        <div className="fixed inset-0 z-[70] bg-black flex flex-col safe-area-pad">
            <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                poster={NO_POSTER}
                className="flex-1 w-full object-contain -scale-x-100 bg-black"
            />
            {recording && (
                <div className="absolute top-[calc(1rem+var(--wolp-sat))] left-1/2 -translate-x-1/2 flex items-center gap-2 text-white text-sm">
                    <span className="w-2.5 h-2.5 rounded-full bg-red-600 animate-pulse"/>
                    <span className="tabular-nums">{formatMs(elapsedMs)}</span>
                    <span className="text-gray-400 tabular-nums">/ {formatMs(VIDEO_MAX_DURATION_MS)}</span>
                </div>
            )}
            <div className="shrink-0 flex items-center justify-center gap-10 py-6 bg-black">
                <button onClick={cancel} aria-label={t("chat.cancelRecording")} className="text-white/80 hover:text-white text-lg">
                    {t("common.cancel")}
                </button>
                {recording ? (
                    <button
                        onClick={() => void finish()}
                        aria-label={t("chat.sendVoice")}
                        className="w-16 h-16 rounded-full bg-red-600 ring-4 ring-white/40 flex items-center justify-center"
                    >
                        <span className="w-6 h-6 bg-white rounded-sm"/>
                    </button>
                ) : (
                    <button
                        onClick={() => start()}
                        aria-label={t("chat.recordVideo")}
                        disabled={!stream}
                        className="w-16 h-16 rounded-full bg-red-600 ring-4 ring-white/40 disabled:opacity-50"
                    />
                )}
                <span className="w-16"/>
            </div>
        </div>
    );
}
