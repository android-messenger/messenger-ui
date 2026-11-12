// Rekey hint: a metadata-only control frame a recipient device sends when it receives a secret envelope
// addressed to its USER but not to its own deviceId (a parallel/new device the sender didn't encrypt to).
// It tells the sender "your device roster for this chat is stale — re-resolve me". It carries NO key
// material and NO device id: acting on it only triggers a re-fetch from the auth-bound directory, so a
// spoofed hint can at most cause a bounded, rate-limited re-fetch — never a redirect to an attacker device.
// It rides the same opaque SIGNAL channel as calls / recovery (frameBridge routes the "e2ee:" prefix).

export const REKEY_HINT = "e2ee:rekey";

export interface RekeyHint {
    type: typeof REKEY_HINT;
    to: string;              // the sender to nudge (counterpart user id)
    conversationId: string;  // the chat this concerns
}

/** Build the outgoing rekey-hint frame (metadata only). */
export function buildRekeyHint(peerId: string, chatId: string): RekeyHint {
    return { type: REKEY_HINT, to: peerId, conversationId: chatId };
}

/** A per-key time throttle: returns true at most once per `windowMs` for a given key. Used to coalesce both
 * hint EMISSION (many mis-addressed envelopes → one hint per peer) and hint HANDLING (many hints → one
 * re-resolve per peer). */
export function makeThrottle(windowMs: number): (key: string, now?: number) => boolean {
    const last = new Map<string, number>();
    const MAX = 512; // bound the map: the inbound-hint throttle is keyed by a SERVER-controlled `from`, so an
                     // adversarial server could otherwise grow it unboundedly (slow memory DoS).
    return (key: string, now = Date.now()) => {
        const t = last.get(key);
        if (t !== undefined && now - t < windowMs) return false; // presence check, so the first call always fires
        if (last.size >= MAX) { // prune entries past the window (they'd fire anyway) before inserting
            for (const [k, ts] of last) if (now - ts >= windowMs) last.delete(k);
        }
        last.set(key, now);
        return true;
    };
}

export const REKEY_COALESCE_MS = 10_000;
