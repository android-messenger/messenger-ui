// Lightweight app diagnostics surfaced on the Info page: build identity, session start, and a rolling
// count of WebSocket (re)connections. All in-memory — the connect ring resets on reload, which is fine for
// a "last N minutes" reading.

declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

export const appVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
export const buildTime = typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "";

const connects: number[] = [];
/** Record a WebSocket open (called from the ws layer on every onopen). */
export function recordConnect(): void {
    connects.push(Date.now());
    if (connects.length > 500) connects.splice(0, connects.length - 500);
}
/** How many WS connects happened in the last `ms` (≈ reconnect activity). */
export function connectsInLast(ms: number): number {
    const cutoff = Date.now() - ms;
    return connects.filter((t) => t >= cutoff).length;
}

/** Connect counts split into `buckets` equal time slices over the last `windowMs` — for a sparkline. */
export function connectBuckets(windowMs: number, buckets: number): number[] {
    const now = Date.now(), start = now - windowMs, size = windowMs / buckets;
    const out = new Array(buckets).fill(0) as number[];
    for (const t of connects) {
        if (t < start || t > now) continue;
        out[Math.min(buckets - 1, Math.floor((t - start) / size))]++;
    }
    return out;
}

let loginAt = 0;
/** Mark the session start (first successful auth this page load). Idempotent. */
export function markLogin(): void { if (!loginAt) loginAt = Date.now(); }
export function getLoginAt(): number { return loginAt; }
