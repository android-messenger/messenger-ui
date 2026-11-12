import {ICE_SERVERS} from "@/shared/config/webrtc";
import {fetchTurnCredentials} from "@/features/e2ee";
import {logger} from "@/shared/logger/logger.ts";

// Build the RTCConfiguration for a call: our own STUN (no auth) plus SHORT-LIVED TURN credentials fetched
// from the key directory (coturn use-auth-secret). No static TURN password is baked into the bundle.
// Cached until shortly before the credential expires; on fetch failure we fall back to STUN-only (P2P still
// works, only relay is unavailable) and retry soon.

let cache: {config: RTCConfiguration; expiresAt: number} | null = null;

export async function getIceConfig(): Promise<RTCConfiguration> {
    const now = Date.now();
    if (cache && now < cache.expiresAt) return cache.config;

    const iceServers: RTCIceServer[] = [...(ICE_SERVERS.iceServers ?? [])]; // STUN base
    try {
        const t = await fetchTurnCredentials();
        if (t.uris?.length) iceServers.push({urls: t.uris, username: t.username, credential: t.credential});
        // Refresh a minute before expiry so an in-flight call always has valid creds.
        cache = {config: {iceServers}, expiresAt: now + Math.max(30, t.ttl - 60) * 1000};
    } catch (e) {
        logger.warn("call: TURN credentials unavailable — STUN-only (no relay this call)", e as Error);
        cache = {config: {iceServers}, expiresAt: now + 30_000}; // short cache → retry soon
    }
    return cache.config;
}
