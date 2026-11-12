// Asset-free notification sound: a short WebAudio blip. This is the ONLY notification concern that
// belongs in shared — it's a generic, stateless sound util with no chat/notification policy. The
// desktop-notification policy (permission lifecycle + the single-arbiter routing) lives in
// features/notifications/desktopNotification.ts. Best-effort: autoplay policy may suppress the blip
// (audio needs a prior user gesture).

let ctx: AudioContext | null = null;

function audioCtx(): AudioContext | null {
    try {
        if (!ctx) {
            const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!AC) return null;
            ctx = new AC();
        }
        return ctx;
    } catch {
        return null;
    }
}

/**
 * The shared AudioContext, so other audio (e.g. the voice-note playback gain boost) reuses the ONE
 * context that unlockAudio() already resumes on the first user gesture — instead of spinning up a fresh
 * suspended context per element, which made the FIRST play silent (context not yet running). Returns null
 * if WebAudio is unavailable.
 */
export function getSharedAudioContext(): AudioContext | null {
    return audioCtx();
}

/** Short two-tone blip via WebAudio (no media asset needed). */
export function playNotificationSound() {
    const ac = audioCtx();
    if (!ac) return;
    try {
        if (ac.state === "suspended") ac.resume().catch(() => {});
        const now = ac.currentTime;
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(660, now);
        osc.frequency.setValueAtTime(880, now + 0.08);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.15, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
        osc.connect(gain).connect(ac.destination);
        osc.start(now);
        osc.stop(now + 0.24);
    } catch { /* ignore */ }
}

// A context can be paused as "suspended" (autoplay policy / backgrounded) or, on iOS, "interrupted" (another
// app took audio focus — e.g. after a previous call). Both need resume(); the standard TS type omits
// "interrupted", so compare as a string.
function needsResume(ac: AudioContext): boolean {
    const s = ac.state as string;
    return s === "suspended" || s === "interrupted";
}

/**
 * Unlock audio from a user gesture: resume the AudioContext AND "prime" the HTML ringtone element (play it
 * muted once, then pause) so a later loop-play is allowed by autoplay policy. Browsers keep both locked until
 * a gesture. Wired to pointerdown/keydown at app start (see App). Idempotent + best-effort.
 */
export function unlockAudio() {
    const ac = audioCtx();
    if (ac && needsResume(ac)) ac.resume().catch(() => {});
    primeRingtone();
}

// Resume a suspended/interrupted context and WAIT for it — scheduling oscillators while it's still paused
// pins them to a frozen currentTime, so on resume their start time is already in the past and the browser
// drops/clips them (the WebAudio fallback's "first ring silent" bug).
async function ensureRunning(ac: AudioContext): Promise<void> {
    if (needsResume(ac)) { try { await ac.resume(); } catch { /* blocked outside a gesture */ } }
}

// Mobile browsers pause the AudioContext when the page goes to the background and don't auto-resume on
// return. Re-warm it whenever the app regains the foreground (best-effort).
if (typeof document !== "undefined") {
    const rewarm = () => { if (ctx && needsResume(ctx)) ctx.resume().catch(() => {}); };
    document.addEventListener("visibilitychange", () => { if (!document.hidden) rewarm(); });
    if (typeof window !== "undefined") window.addEventListener("focus", rewarm);
}

// --- incoming/outgoing call ringtone -----------------------------------------------------------------
// Primary: a preloaded, natively-looping <audio> element. Far more reliable than scheduled WebAudio on
// mobile — it survives audio-session routing changes and doesn't depend on the context clock — but needs a
// one-time gesture "prime" (muted play→pause) before a later loop-play is allowed. If it's unavailable (no
// HTMLAudio / blocked play), we fall back to the asset-free WebAudio burst loop. The clip itself is a WAV
// blob generated at runtime, so this stays asset-free.
let ringEl: HTMLAudioElement | null = null;
let ringElTried = false;
let ringPrimed = false;
let ringViaEl = false;
let ringActive = false;                 // are we supposed to be ringing right now?
let ringGen = 0;                        // bumped on every start/stop, to invalidate a late play() rejection
let ringTimer: ReturnType<typeof setInterval> | null = null;

function ringtoneEl(): HTMLAudioElement | null {
    if (ringElTried) return ringEl;
    ringElTried = true;
    try {
        if (typeof Audio === "undefined") return null;
        const url = buildRingtoneUrl();
        if (!url) return null;
        ringEl = new Audio(url);
        ringEl.loop = true;
        ringEl.preload = "auto";
    } catch { ringEl = null; }
    return ringEl;
}

function primeRingtone() {
    if (ringPrimed) return;
    const el = ringtoneEl();
    if (!el) return;
    try {
        el.muted = true;
        const p = el.play();
        const settle = () => { try { el.pause(); el.currentTime = 0; el.muted = false; ringPrimed = true; } catch { /* ignore */ } };
        if (p && typeof p.then === "function") p.then(settle).catch(() => { try { el.muted = false; } catch { /* ignore */ } });
        else settle();
    } catch { try { el.muted = false; } catch { /* ignore */ } }
}

/** Start the looping ringtone (incoming call / outgoing ringback). No-op if already ringing. */
export function startRinging() {
    if (ringActive) return;                         // already ringing
    ringActive = true;
    const gen = ++ringGen;
    const el = ringtoneEl();
    if (el) {
        try {
            el.muted = false;
            el.currentTime = 0;
            ringViaEl = true;
            const p = el.play();
            // A late play() rejection must NOT resurrect the ring after a stop (or a restart): only fall
            // back to WebAudio if this same start is still the active one.
            if (p && typeof p.catch === "function") p.catch(() => {
                if (gen !== ringGen || !ringActive) return;
                ringViaEl = false;
                startWebAudioRing();
            });
            return;
        } catch { ringViaEl = false; /* fall through to WebAudio */ }
    }
    startWebAudioRing();
}

/** Stop the ringtone (both paths). */
export function stopRinging() {
    ringActive = false;
    ringGen++;                                      // invalidate any in-flight play() rejection
    if (ringEl && ringViaEl) { try { ringEl.pause(); ringEl.currentTime = 0; } catch { /* ignore */ } }
    ringViaEl = false;
    if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
}

// --- WebAudio fallback loop --------------------------------------------------------------------------
async function ringBurst() {
    const ac = audioCtx();
    if (!ac) return;
    await ensureRunning(ac);             // resume FIRST, then schedule against a live clock
    const base = ac.currentTime;
    for (const offset of [0, 0.45]) {    // two beeps: classic "ring-ring"
        const t = base + offset;
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(480, t);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.6, t + 0.02);
        gain.gain.setValueAtTime(0.6, t + 0.3);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.36);
        osc.connect(gain).connect(ac.destination);
        osc.start(t);
        osc.stop(t + 0.38);
    }
}

function startWebAudioRing() {
    if (ringTimer) return;
    void ringBurst();
    ringTimer = setInterval(() => { void ringBurst(); }, 2600);
}

// Asset-free ringtone clip: a 2.6s "ring-ring" loop (two 480 Hz beeps, then silence) as a 16-bit PCM WAV
// blob. Returns an object URL, or null where Blob/URL aren't available.
function buildRingtoneUrl(): string | null {
    try {
        if (typeof Blob === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) return null;
        const sr = 16000, n = Math.floor(sr * 2.6);
        const buf = new ArrayBuffer(44 + n * 2);
        const dv = new DataView(buf);
        const put = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
        put(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); put(8, "WAVE");
        put(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
        dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
        put(36, "data"); dv.setUint32(40, n * 2, true);
        const beeps: Array<[number, number]> = [[0, 0.33], [0.45, 0.78]];   // then silence to 2.6s → ring cadence
        for (let i = 0; i < n; i++) {
            const t = i / sr;
            let amp = 0;
            for (const [s, e] of beeps) {
                if (t >= s && t < e) {
                    const local = t - s, env = Math.min(1, local / 0.02) * Math.min(1, (e - t) / 0.03);
                    amp = 0.5 * env * Math.sin(2 * Math.PI * 480 * t);
                }
            }
            dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, amp)) * 32767, true);
        }
        return URL.createObjectURL(new Blob([buf], {type: "audio/wav"}));
    } catch { return null; }
}
