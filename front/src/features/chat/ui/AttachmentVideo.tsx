import {useCallback, useEffect, useRef, useState, type SyntheticEvent} from "react";
import {useTranslation} from "react-i18next";
import {useSelector} from "react-redux";
import type {RootState} from "@/store/store";
import {loadAttachmentBlob, saveAttachmentBlob} from "@/features/chat/db/db.ts";
import {videoPosterBlob} from "@/features/chat/lib/videoPoster.ts";
import {targetDimensions} from "@/features/chat/lib/imageCompress.ts";
import {THUMB_MAX_DIMENSION, THUMB_QUALITY} from "@/shared/config/chat.ts";

/**
 * Inline video attachment with CLICK-TO-PLAY. Opening a chat must NOT eagerly stream every video: the old
 * behavior mounted a <video preload="metadata"> per clip, which fetched each file's head AND ran the
 * MediaRecorder-webm duration hack (a seek to the end that scans the whole remote file) — N videos = a
 * visibly janky chat open. Now we show only a cheap POSTER (a small first-frame WebP cached in IndexedDB,
 * keyed by attachmentId) plus a play button; nothing is resolved or streamed until the user taps play.
 *
 * On first play we resolve the presigned URL, stream the clip, draw the first decoded frame to a downscaled
 * WebP poster and cache it — so the next time the chat opens this video shows a real thumbnail instantly,
 * still with zero streaming. A video with no cached poster yet just shows a generic placeholder until its
 * first play. Resolve is retried for a just-uploaded object; a playback error re-resolves a fresh URL.
 */
export function AttachmentVideo({
    attachmentId,
    fileName,
    resolveUrl,
}: {
    attachmentId: string;
    fileName: string;
    resolveUrl?: (attachmentId: string) => Promise<string | null>;
}) {
    const {t} = useTranslation();
    const [playing, setPlaying] = useState(false);            // user tapped play → resolve + stream
    const [url, setUrl] = useState<string | null>(null);      // presigned URL (streamed)
    const [poster, setPoster] = useState<string | null>(null); // objectURL of the cached/generated frame
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const playbackErrors = useRef(0);
    const posterDone = useRef(false);          // generate/attach the poster at most once
    const posterUrlRef = useRef<string | null>(null); // live poster objectURL, for revoke
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const rootRef = useRef<HTMLButtonElement | null>(null);   // the poster button, for the visibility observer
    const posterGenRef = useRef(false);                        // receiver-side poster generated at most once

    const [prevId, setPrevId] = useState(attachmentId);
    if (attachmentId !== prevId) {
        setPrevId(attachmentId);
        setPlaying(false); setUrl(null); setPoster(null); setFailed(false);
    }

    // STOP the clip on ANY navigation. The chat panel is hidden via CSS (not unmounted) and an
    // IntersectionObserver doesn't reliably fire for display:none, so a played video would keep running
    // and appear to "auto-play" when you return. Keying off selectedChatId is the reliable signal: the
    // moment the open chat changes (to another chat OR the list/home), reset playing → the <video>
    // unmounts (stops) and re-entering shows the poster. A new message in the SAME chat doesn't change it.
    const selectedChatId = useSelector((s: RootState) => s.chatUi.selectedChatId);
    const [prevChat, setPrevChat] = useState(selectedChatId);
    if (selectedChatId !== prevChat) {
        setPrevChat(selectedChatId);
        if (playing) setPlaying(false);
    }

    // Set the poster, revoking any previous objectURL first; revoke on unmount too. Stable callback (only
    // ever invoked from effects/handlers, never during render).
    const applyPoster = useCallback((blob: Blob) => {
        if (posterUrlRef.current) URL.revokeObjectURL(posterUrlRef.current);
        posterUrlRef.current = URL.createObjectURL(blob);
        setPoster(posterUrlRef.current);
    }, []);
    useEffect(() => () => {
        if (posterUrlRef.current) { URL.revokeObjectURL(posterUrlRef.current); posterUrlRef.current = null; }
    }, []);

    // Serve a cached first-frame poster immediately if we have one (cheap local read, NO streaming). This
    // is the only work done on chat open — everything else waits for a play tap.
    useEffect(() => {
        let alive = true;
        posterDone.current = false;   // reset per attachment (kept out of render — ref writes there are illegal)
        posterGenRef.current = false;
        let tries = 0;
        const MAX = 6;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tryLoad = () => {
            loadAttachmentBlob(attachmentId).then((blob) => {
                if (!alive) return;
                if (blob) { posterDone.current = true; applyPoster(blob); return; }
                // No cached poster YET. A just-SENT video generates its poster asynchronously (from the
                // local blob, after upload confirms — see useChatAttachments), so it can land a second or
                // two AFTER this bubble first renders. Retry briefly so the sender sees the thumbnail
                // without having to play the clip first. Received videos (no sender poster) simply fall
                // through to the placeholder after the retries — generated on their first play.
                if (++tries < MAX) timer = setTimeout(tryLoad, 1200);
            }).catch(() => { /* no cached poster yet */ });
        };
        tryLoad();
        return () => { alive = false; if (timer) clearTimeout(timer); };
    }, [attachmentId, applyPoster]);

    // RECEIVER-side poster: the send-time poster is cached only on the SENDER's device, so a received
    // video shows a black placeholder until it's played. When the bubble scrolls INTO VIEW (and we still
    // have no poster), fetch the clip once in the background, extract a first frame, cache it — so the
    // receiver sees a real thumbnail without having to play. Gated on visibility so off-screen videos and
    // fast scroll-bys don't download; runs at most once per attachment (cached forever after).
    useEffect(() => {
        if (poster || playing || posterGenRef.current || typeof IntersectionObserver === "undefined") return;
        const el = rootRef.current;
        if (!el) return;
        const io = new IntersectionObserver((entries) => {
            if (posterGenRef.current || !entries.some((e) => e.isIntersecting)) return;
            posterGenRef.current = true;
            io.disconnect();
            void (async () => {
                try {
                    const u = await resolveUrl?.(attachmentId);
                    if (!u) return;
                    const resp = await fetch(u, {credentials: "include"}); // app build: cross-origin edge (see useAttachmentObjectUrl)
                    if (!resp.ok) return;
                    const p = await videoPosterBlob(await resp.blob());
                    if (p) { void saveAttachmentBlob(attachmentId, p).catch(() => {}); posterDone.current = true; applyPoster(p); }
                } catch { /* best-effort; falls back to on-play generation */ }
            })();
        }, {threshold: 0.1});
        io.observe(el);
        return () => io.disconnect();
    }, [poster, playing, attachmentId, resolveUrl, applyPoster]);

    // Pause the clip when the TAB/app is backgrounded (not just when navigating chats) — otherwise a
    // playing video keeps running its audio in the background. Resets to the poster so re-entry is calm.
    useEffect(() => {
        if (!playing) return;
        const onHide = () => { if (document.hidden) { try { videoRef.current?.pause(); } catch { /* ignore */ } } };
        document.addEventListener("visibilitychange", onHide);
        return () => document.removeEventListener("visibilitychange", onHide);
    }, [playing]);

    // Resolve the presigned URL — ONLY after the user asks to play (deferred so a chat open doesn't hit the
    // backend for every video). Retried for a just-uploaded object.
    useEffect(() => {
        if (!playing) return;
        let alive = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let tries = 0;
        const MAX = 4;
        const go = () => {
            resolveUrl?.(attachmentId)
                .then((u) => {
                    if (!alive) return;
                    if (u) { setUrl(u); return; }
                    if (++tries < MAX) timer = setTimeout(go, 800 * tries); else setFailed(true);
                })
                .catch(() => {
                    if (!alive) return;
                    if (++tries < MAX) timer = setTimeout(go, 800 * tries); else setFailed(true);
                });
        };
        go();
        return () => { alive = false; if (timer) clearTimeout(timer); };
    }, [playing, attachmentId, attempt, resolveUrl]);

    // First decoded frame → draw, downscale to a WebP poster, cache it, show it (so the NEXT chat open has
    // a real thumbnail with no streaming).
    const onLoadedData = (e: SyntheticEvent<HTMLVideoElement>) => {
        if (posterDone.current) return;
        const v = e.currentTarget;
        if (!v.videoWidth || !v.videoHeight) return;
        posterDone.current = true;
        try {
            const {width, height} = targetDimensions(v.videoWidth, v.videoHeight, THUMB_MAX_DIMENSION);
            const canvas = document.createElement("canvas");
            canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            ctx.drawImage(v, 0, 0, width, height);
            canvas.toBlob((blob) => {
                if (!blob) return;
                saveAttachmentBlob(attachmentId, blob).catch(() => { /* best-effort cache */ });
                applyPoster(blob);
            }, "image/webp", THUMB_QUALITY);
        } catch { /* tainted/unsupported → the #t=0.1 frame still previews */ }
    };

    // A MediaRecorder webm (recorded IN the app) has no Duration in its header → the <video> seek bar /
    // total time break. Same one-shot seek-to-end hack as voice notes. Now that it only runs AFTER a play
    // tap (not on chat open), its cost is off the open path. (Gallery MP4s already report a duration.)
    const durationFixed = useRef(false);
    const onLoadedMetadata = (e: SyntheticEvent<HTMLVideoElement>) => {
        const v = e.currentTarget;
        if (durationFixed.current) return;
        if (v.duration === Infinity || Number.isNaN(v.duration)) {
            durationFixed.current = true;
            const onTimeUpdate = () => { v.removeEventListener("timeupdate", onTimeUpdate); v.currentTime = 0; };
            v.addEventListener("timeupdate", onTimeUpdate);
            v.currentTime = 1e101;
        }
    };

    // Pause the video whenever it's not actually on screen. The chat panel is HIDDEN via CSS (display:none),
    // not unmounted — so a playing clip would otherwise keep running in the background and appear to
    // "auto-play" when you return to the chat. IntersectionObserver reports display:none AND scroll-away as
    // not-intersecting; we only pause (keep position + controls), never auto-resume.
    useEffect(() => {
        if (!playing) return;
        const el = videoRef.current;
        if (!el || typeof IntersectionObserver === "undefined") return;
        const io = new IntersectionObserver((entries) => {
            for (const e of entries) if (!e.isIntersecting && !el.paused) el.pause();
        }, {threshold: 0});
        io.observe(el);
        return () => io.disconnect();
    }, [playing]);

    const retry = () => { setFailed(false); setUrl(null); setAttempt((a) => a + 1); };
    const onVideoError = () => {
        if (playbackErrors.current < 2) { playbackErrors.current += 1; retry(); } // maybe an expired URL
        else setFailed(true);
    };

    if (failed) return (
        <button onClick={retry} className="break-all underline decoration-dotted" title={fileName}>
            🎬 {t("chat.video")} — ↻
        </button>
    );

    // Not playing yet → cheap poster + play overlay. No URL resolve, no stream, no metadata scan.
    if (!playing) {
        return (
            <button
                ref={rootRef}
                type="button"
                onClick={() => setPlaying(true)}
                className="relative block max-w-[240px] max-h-[240px] rounded-md bg-black overflow-hidden"
                title={fileName}
                aria-label={t("chat.video")}
            >
                {poster
                    ? <img src={poster} alt={fileName} className="block max-w-[240px] max-h-[240px] object-contain"/>
                    : <div className="flex items-center justify-center w-[240px] h-[160px] text-3xl">🎬</div>}
                <span className="absolute inset-0 flex items-center justify-center">
                    <span className="flex items-center justify-center w-12 h-12 rounded-full bg-black/55">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="white" aria-hidden="true">
                            <path d="M8 5v14l11-7z"/>
                        </svg>
                    </span>
                </span>
            </button>
        );
    }

    // Playing → resolve (if needed) + stream.
    if (!url) return <span className="opacity-60 text-xs">🎬 {t("chat.video")}…</span>;
    return (
        <video
            ref={videoRef}
            controls
            autoPlay
            preload="metadata"
            src={`${url}#t=0.1`}
            poster={poster ?? undefined}
            onLoadedData={onLoadedData}
            onLoadedMetadata={onLoadedMetadata}
            onError={onVideoError}
            className="block max-w-[240px] max-h-[240px] rounded-md bg-black"
            title={fileName}
        >
            <a href={url} target="_blank" rel="noopener">🎬 {t("chat.video")}</a>
        </video>
    );
}
