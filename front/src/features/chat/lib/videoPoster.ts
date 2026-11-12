import {targetDimensions} from "./imageCompress.ts";
import {THUMB_MAX_DIMENSION, THUMB_QUALITY} from "@/shared/config/chat.ts";

type RVFCVideo = HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number;
};

/**
 * Generate a small first-frame WebP poster from a LOCAL video File/Blob — used at SEND time so the
 * sender's just-uploaded clip shows a real thumbnail immediately instead of a black 🎬 placeholder
 * (the receiver-side poster is still generated on first play). Best-effort: resolves null on any
 * failure and never throws.
 *
 * Mobile is the hard case: a DETACHED <video> often won't decode a frame, so the canvas comes out black
 * or empty. So we (a) attach it off-screen but IN the document, (b) muted+playsInline and call play()
 * (muted autoplay is allowed and forces a decode), and (c) capture via requestVideoFrameCallback when a
 * frame is actually presented (falling back to seeked/loadeddata). A 6s watchdog guarantees we resolve.
 */
export function videoPosterBlob(file: Blob): Promise<Blob | null> {
    return new Promise((resolve) => {
        let settled = false;
        let url: string | null = null;
        const v = document.createElement("video") as RVFCVideo;
        const cleanup = () => {
            try { v.pause(); } catch { /* ignore */ }
            try { v.removeAttribute("src"); v.load(); } catch { /* ignore */ }
            try { v.remove(); } catch { /* ignore */ }
            try { if (url) URL.revokeObjectURL(url); } catch { /* ignore */ }
        };
        const done = (blob: Blob | null) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(blob);
        };
        const capture = () => {
            if (settled || !v.videoWidth || !v.videoHeight) return;
            try {
                const {width, height} = targetDimensions(v.videoWidth, v.videoHeight, THUMB_MAX_DIMENSION);
                const c = document.createElement("canvas");
                c.width = width; c.height = height;
                const ctx = c.getContext("2d");
                if (!ctx) return done(null);
                ctx.drawImage(v, 0, 0, width, height);
                c.toBlob((b) => done(b), "image/webp", THUMB_QUALITY);
            } catch { done(null); }
        };
        try {
            url = URL.createObjectURL(file);
            v.muted = true;
            v.defaultMuted = true;
            v.playsInline = true;
            v.preload = "auto";
            v.setAttribute("muted", "");
            v.setAttribute("playsinline", "");
            // Off-screen but IN the document — some mobile browsers won't decode a detached video.
            v.style.cssText = "position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
            document.body.appendChild(v);
            v.onloadeddata = () => {
                // Nudge past a possibly-black first frame; ignore if seeking isn't supported yet.
                try { v.currentTime = Math.min(0.1, (Number.isFinite(v.duration) ? v.duration : 1) / 2); } catch { /* draw as-is */ }
            };
            v.onseeked = capture;
            v.onerror = () => done(null);
            if (typeof v.requestVideoFrameCallback === "function") {
                v.requestVideoFrameCallback(() => capture());
            }
            v.src = url;
            // Muted autoplay is permitted and forces a decode so a frame is available to draw.
            void v.play().catch(() => { /* fall back to loadeddata/seeked */ });
            setTimeout(() => done(null), 6000);
        } catch { done(null); }
    });
}
