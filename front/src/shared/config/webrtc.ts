// The STUN/TURN server of the stack this build belongs to. Both values come from the build
// (VITE_TURN_HOST, VITE_TURN_PORT) and have NO default: a build without them fails (vite.config.ts), so a
// bundle can never point at somebody else's server. TURN credentials are not in the bundle — they are
// fetched per call (short-lived) via getIceConfig().
const TURN_HOST = (import.meta.env.VITE_TURN_HOST as string | undefined) || "";
const TURN_PORT = (import.meta.env.VITE_TURN_PORT as string | undefined) || "";

/** The STUN entry for the configured server; none when the address is not set (dev server, tests). */
export function stunServers(host: string, port: string): RTCIceServer[] {
    return host && port ? [{urls: `stun:${host}:${port}`}] : [];
}

// If an outgoing call isn't answered/connected within this window, give up (end + toast) instead
// of leaving the caller on a black screen forever. Kept generous (60s) so a callee who was OFFLINE has
// time to receive the call push, open the app and call back while the caller is still ringing — that
// "glare" callback (callMiddleware call:offer) is what connects a closed-app answer. Past the window the
// caller goes idle and the callback simply rings them as a fresh incoming call instead.
export const CALL_TIMEOUT_MS = 60_000;

// STUN-only base (no auth). getIceConfig() appends short-lived TURN creds fetched per call. If that fetch
// fails, calls fall back to this STUN-only config (P2P works; only relay is unavailable).
export const ICE_SERVERS: RTCConfiguration = {
    // Our OWN STUN only — a public STUN would hand a third party the caller's IP and the time of every
    // call, and our coturn already provides STUN on the same host.
    iceServers: stunServers(TURN_HOST, TURN_PORT),
};
