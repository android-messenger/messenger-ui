// Message-list windowing: render only the most recent N bubbles to cap DOM nodes on long
// histories (the history page can be up to 200). "Show earlier messages" reveals another step.
// This is dependency-free virtualization tuned for chat UX (you almost always view the tail).
export const MESSAGE_WINDOW_INITIAL = 60;
export const MESSAGE_WINDOW_STEP = 60;

// History pagination. The backend serves the NEWEST page by default (or `?before=<id>` for the
// page immediately older, ASC), plus `?since=<id>` for a forward reconnect catch-up. So we load
// the latest page on open and pull older pages on demand (scroll-up / "show earlier"). Rendering
// is windowed on top of the loaded set (MESSAGE_WINDOW_*).
export const HISTORY_PAGE_SIZE = 200;

// Max attachment size accepted client-side (before requesting a presigned upload URL).
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB

// Client-side image compression (before upload): downscale proportionally so the longest side is at
// most IMAGE_MAX_DIMENSION and re-encode to WebP at IMAGE_QUALITY. Saves bandwidth/storage and speeds
// up sends. Images already smaller than IMAGE_COMPRESS_MIN_BYTES are sent as-is (not worth it). Encode
// uses jSquash (WASM) with a native canvas fallback; see features/chat/lib/imageCompress.ts.
export const IMAGE_MAX_DIMENSION = 1200;            // px — longest side after downscale (never upscales)
export const IMAGE_QUALITY = 0.8;                   // 0..1 → WebP quality
export const IMAGE_COMPRESS_MIN_BYTES = 150 * 1024; // don't bother compressing images below this

// Inline thumbnail cache (IndexedDB): the small WebP generated from a shown image so re-mounts/scrolls
// render instantly without re-resolving/re-downloading. The chat renders images at ~200px, so 320px
// covers 1x/2x crisply while staying tiny.
export const THUMB_MAX_DIMENSION = 320;
export const THUMB_QUALITY = 0.6;
// Total byte budget for the on-device media cache (image thumbnails + voice notes + video), shared
// across all attachments. On save, oldest entries are evicted until the total fits. Configurable; the
// browser can also evict the whole origin under storage pressure — either way a miss just re-fetches.
export const ATTACHMENT_CACHE_MAX_BYTES = 80 * 1024 * 1024; // 80 MB

// Voice messages: max recording length before auto-send (guards a runaway recording / huge upload).
export const VOICE_MAX_DURATION_MS = 3 * 60 * 1000; // 3 minutes
// Video messages: shorter cap — video is far heavier and bounded by the 25MB attachment limit.
export const VIDEO_MAX_DURATION_MS = 60 * 1000; // 1 minute

// Video CAPTURE limits (useVideoRecorder): cap resolution + bitrate so a phone camera doesn't record
// 1080p at multi-Mbps — that produces huge files that upload slowly and lag on open. 720p @ ~1.2 Mbps is
// plenty for a chat video. Combined with VIDEO_MAX_DURATION_MS this bounds a clip to ~9 MB, well under the
// 25 MB attachment cap. Constraints are advisory: a device that can't hit them just gives its nearest.
export const VIDEO_CAPTURE_MAX_DIMENSION = 1280; // px, cap on BOTH axes → ~720p either orientation
export const VIDEO_CAPTURE_FRAME_RATE = 24;
export const VIDEO_CAPTURE_BITS_PER_SECOND = 1_200_000;  // ~1.2 Mbps video
export const VIDEO_CAPTURE_AUDIO_BITS_PER_SECOND = 64_000; // 64 kbps audio
// Hard byte budget enforced DURING recording (auto-stop). Some devices/codecs ignore the bitrate hint
// above and record much larger, so the duration cap alone doesn't bound the file — this guarantees the
// clip never exceeds the send limit (MAX_ATTACHMENT_BYTES) and gets rejected AT send. Kept comfortably
// under 25MB. Requires the recorder to emit timeslice chunks so size can be tracked live.
export const VIDEO_CAPTURE_MAX_BYTES = 22 * 1024 * 1024; // 22 MB (safely under the 25MB send cap)

// Voice-note playback gain. MediaRecorder mic captures are often quiet, and mobile plays them on the
// (frequently low) MEDIA volume stream — a web app CANNOT raise system volume, but it CAN boost playback
// via a WebAudio GainNode so a voice note is audible at a lower system volume. >1 = louder; kept modest
// to avoid harsh clipping. Best-effort: if WebAudio routing fails we fall back to plain element playback.
export const AUDIO_PLAYBACK_GAIN = 2.5;
