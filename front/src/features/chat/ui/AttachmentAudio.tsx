import {useEffect, useRef, type SyntheticEvent} from "react";
import {useTranslation} from "react-i18next";
import {useAttachmentObjectUrl} from "@/features/chat/lib/useAttachmentObjectUrl.ts";
import {loadAttachmentBlob, saveAttachmentBlob, deleteAttachmentBlob} from "@/features/chat/db/db.ts";
import {AUDIO_PLAYBACK_GAIN} from "@/shared/config/chat.ts";
import {getSharedAudioContext} from "@/shared/sound/notify.ts";

/**
 * Inline player for an audio attachment (voice message). Uses the shared useAttachmentObjectUrl layer:
 * the bytes are fetched into a Blob and played from a local `blob:` URL — never streamed from the
 * presigned URL. That both (a) avoids the endless spinner (MediaRecorder webm has no Duration/Cues in its
 * header, so a streaming <audio> hangs reading metadata over a range-served URL) and (b) makes a presigned
 * URL expiring irrelevant once fetched. The blob is persisted in the shared size-bounded media cache, so
 * re-opening a chat replays voice notes instantly (and offline) instead of re-downloading.
 */
export function AttachmentAudio({
    attachmentId,
    fileName,
    resolveUrl,
}: {
    attachmentId: string;
    fileName: string;
    resolveUrl?: (attachmentId: string) => Promise<string | null>;
}) {
    const {t} = useTranslation();
    const {url, failed, retry} = useAttachmentObjectUrl({
        attachmentId, resolveUrl,
        load: loadAttachmentBlob, save: saveAttachmentBlob, invalidate: deleteAttachmentBlob,
    });
    const durationFixed = useRef(false);
    const nodesRef = useRef<{src: MediaElementAudioSourceNode; gain: GainNode} | null>(null);

    // Boost quiet voice notes on playback via a WebAudio GainNode (a web app can't raise the device MEDIA
    // volume, but it can make the note audible at a lower one). Reuse the SHARED AudioContext — the one
    // unlockAudio() already resumed on the app's first gesture — instead of a fresh per-element context,
    // which started suspended and made the FIRST play SILENT (only the 2nd had sound). Wire the element
    // through the graph once; if the shared context is somehow still suspended, resume + re-play so the
    // first play isn't lost. Best-effort: any failure leaves the element playing natively (unboosted).
    const onPlay = (e: SyntheticEvent<HTMLAudioElement>) => {
        const a = e.currentTarget;
        a.volume = 1;
        const ac = getSharedAudioContext();
        if (!ac) return;
        try {
            if (!nodesRef.current) {
                const src = ac.createMediaElementSource(a);
                const gain = ac.createGain();
                gain.gain.value = AUDIO_PLAYBACK_GAIN;
                src.connect(gain).connect(ac.destination);
                nodesRef.current = {src, gain};
            }
            if (ac.state === "suspended") {
                // Not unlocked yet → the running graph won't output until resumed; re-play so the first
                // play has sound rather than being swallowed while the context spins up.
                a.pause();
                ac.resume().finally(() => { void a.play().catch(() => {}); });
            }
        } catch { /* WebAudio blocked → native element playback */ }
    };
    // Disconnect this element's WebAudio nodes on unmount so they don't pile up in the SHARED, never-closed
    // context (each played voice note otherwise leaks a MediaElementSource + GainNode + pins the <audio>).
    useEffect(() => () => {
        try { nodesRef.current?.gain.disconnect(); nodesRef.current?.src.disconnect(); } catch { /* ignore */ }
        nodesRef.current = null;
    }, []);

    // MediaRecorder webm has no Duration in its header → the <audio> reports duration=Infinity and the
    // seek bar / total time are broken. Force a real duration: seek to the end once (the blob is local
    // and complete, so this resolves instantly), then snap back to the start.
    const onLoadedMetadata = (e: SyntheticEvent<HTMLAudioElement>) => {
        const a = e.currentTarget;
        if (durationFixed.current) return;
        if (a.duration === Infinity || Number.isNaN(a.duration)) {
            durationFixed.current = true;
            const onTimeUpdate = () => { a.removeEventListener("timeupdate", onTimeUpdate); a.currentTime = 0; };
            a.addEventListener("timeupdate", onTimeUpdate);
            a.currentTime = 1e101;
        }
    };

    if (failed) return (
        <button onClick={retry} className="break-all underline decoration-dotted" title={fileName}>
            🎙 {t("chat.voiceMessage")} — ↻
        </button>
    );
    if (!url) return <span className="opacity-60 text-xs">🎙 {t("chat.voiceMessage")}…</span>;
    return (
        <audio controls src={url} onLoadedMetadata={onLoadedMetadata} onPlay={onPlay} onError={retry}
               className="max-w-[240px] h-9" title={fileName}>
            <a href={url} target="_blank" rel="noopener">🎙 {t("chat.voiceMessage")}</a>
        </audio>
    );
}
