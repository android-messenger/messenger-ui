import {useCallback, useEffect, useRef, useState} from "react";
import toast from "react-hot-toast";
import {useTranslation} from "react-i18next";

import {logger} from "@/shared/logger/logger.ts";

/**
 * Microphone recording for voice messages. Tap-to-toggle: start() opens the mic and begins recording,
 * stop() finalizes and resolves the recorded audio as a File (ready for the normal attachment upload),
 * cancel() discards it. `elapsedMs` ticks while recording so the composer can show a timer and enforce
 * a max length. The mic stream is always released (tracks stopped) on stop/cancel/unmount.
 *
 * No backend contract of its own — the produced File goes through the same presigned-upload path as any
 * attachment; playback is a native <audio> over the presigned GET (see AttachmentAudio).
 */

const MIME_CANDIDATES = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4", // Safari
];

function pickMimeType(): string {
    if (typeof MediaRecorder === "undefined") return "";
    for (const c of MIME_CANDIDATES) {
        try { if (MediaRecorder.isTypeSupported(c)) return c; } catch { /* ignore */ }
    }
    return "";
}

function extForMime(mime: string): string {
    if (mime.includes("mp4")) return "m4a";
    if (mime.includes("ogg")) return "ogg";
    return "webm";
}

export function useVoiceRecorder() {
    const {t} = useTranslation();
    const [recording, setRecording] = useState(false);
    const [elapsedMs, setElapsedMs] = useState(0);

    const recRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const mimeRef = useRef("");
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const startedAtRef = useRef(0);
    const resolveRef = useRef<((f: File | null) => void) | null>(null);
    const startingRef = useRef(false); // synchronous re-entrancy guard: getUserMedia is async, recRef is
                                       // set only after it resolves, so two fast taps could both start.

    const releaseStream = () => {
        streamRef.current?.getTracks().forEach((tr) => tr.stop());
        streamRef.current = null;
    };
    const clearTimer = () => {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
    };

    const start = useCallback(async (): Promise<boolean> => {
        if (recRef.current || startingRef.current || typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
            if (typeof MediaRecorder === "undefined") toast.error(t("chat.micError"));
            return false;
        }
        startingRef.current = true;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({audio: true});
            streamRef.current = stream;
            const mime = pickMimeType();
            mimeRef.current = mime;
            const rec = new MediaRecorder(stream, mime ? {mimeType: mime} : undefined);
            chunksRef.current = [];
            rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
            rec.onstop = () => {
                // Upload a CLEAN base content-type ("audio/webm"), NOT the recorder's parameterized
                // "audio/webm;codecs=opus" — the `;codecs=…` parameter trips server-side attachment
                // handling (the message wasn't durably stored, so a voice note vanished on the next
                // history refetch). The webm/opus bytes are unchanged; browsers play "audio/webm" fine.
                const type = (mimeRef.current || "audio/webm").split(";")[0];
                const file = chunksRef.current.length > 0
                    ? new File([new Blob(chunksRef.current, {type})], `voice-${Date.now()}.${extForMime(type)}`, {type})
                    : null;
                chunksRef.current = [];
                releaseStream();
                const resolve = resolveRef.current;
                resolveRef.current = null;
                resolve?.(file);
            };
            recRef.current = rec;
            rec.start();
            startedAtRef.current = Date.now();
            setElapsedMs(0);
            setRecording(true);
            timerRef.current = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 200);
            return true;
        } catch (e) {
            logger.error("voice recording failed to start", e as Error);
            toast.error(t("chat.micError"));
            releaseStream();
            recRef.current = null;
            setRecording(false);
            return false;
        } finally {
            startingRef.current = false;
        }
    }, [t]);

    // Finalize: resolves the recorded File (or null if nothing captured). onstop releases the stream.
    const stop = useCallback((): Promise<File | null> => {
        return new Promise((resolve) => {
            const rec = recRef.current;
            recRef.current = null;
            clearTimer();
            setRecording(false);
            if (!rec || rec.state === "inactive") { releaseStream(); resolve(null); return; }
            resolveRef.current = resolve;
            rec.stop();
        });
    }, []);

    // Discard: stop recording, drop the audio, release the mic.
    const cancel = useCallback(() => {
        const rec = recRef.current;
        recRef.current = null;
        resolveRef.current = null;
        chunksRef.current = [];
        clearTimer();
        setRecording(false);
        setElapsedMs(0);
        if (rec && rec.state !== "inactive") {
            rec.onstop = () => releaseStream();
            rec.stop();
        } else {
            releaseStream();
        }
    }, []);

    // Safety net: release the mic if the component unmounts mid-recording.
    useEffect(() => () => {
        clearTimer();
        const rec = recRef.current;
        if (rec && rec.state !== "inactive") { rec.onstop = null; try { rec.stop(); } catch { /* ignore */ } }
        releaseStream();
    }, []);

    return {recording, elapsedMs, start, stop, cancel};
}
