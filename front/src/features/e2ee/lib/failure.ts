// Failure taxonomy for the secret path (reviewer #19 + #24). One place that (a) names the library's hard
// skip ceiling, (b) classifies a raw libsignal decrypt error into a small, meaningful set, and (c) maps a
// message's crypto outcome to the single string the user sees. Keeping it here — not scattered across the
// chat middleware — is what makes the failure modes auditable and testable.

// The library (@privacyresearch/libsignal-protocol-typescript, session-cipher.js) hard-caps a single
// forward fill at 2000 keys ("Over 2000 messages into the future!") and self-evicts old chains/sessions
// (OLD_RATCHETS_MAX_LENGTH=10, ARCHIVED_STATES_MAX_LENGTH=40). So skipped-key memory is bounded WITHOUT us
// forking the library; a gap wider than this is un-healable on the live chain and must go to recovery.
export const MAX_SKIP_PER_CHAIN = 2000;

export type DecryptFailure =
    | "hard-gap"      // skipped past MAX_SKIP, or the message key was never filled → can't heal on THIS chain
    | "duplicate"     // the message key was already consumed (replay / redelivery of something we decrypted)
    | "no-session"    // no session/identity for this sender/device yet
    | "wrong-device"  // the envelope carries no ciphertext for THIS device → the sender has a stale device roster
    | "corrupt"       // malformed envelope / undecodable ciphertext (not recoverable by re-request)
    | "unknown";

/** Classify a raw error thrown by the ratchet/seam into the taxonomy above (best-effort on message text). */
export function classifyDecryptError(e: unknown): DecryptFailure {
    const msg = (e instanceof Error ? e.message : String(e ?? "")).toLowerCase();
    if (msg.includes("no ciphertext for this device")) return "wrong-device"; // we're a parallel/new device the sender didn't encrypt to
    if (msg.includes("into the future")) return "hard-gap";                 // > MAX_SKIP_PER_CHAIN
    if (msg.includes("counter was repeated") || msg.includes("key not found")) return "hard-gap"; // gap or dup — treat as gap; a real dup is served from at-rest before we ever get here
    if (msg.includes("no record") || msg.includes("no session") || msg.includes("identity")) return "no-session";
    if (msg.includes("not an envelope") || msg.includes("json") || msg.includes("unexpected token") || msg.includes("base64")) return "corrupt";
    return "unknown";
}

/** Whether a failure can plausibly be repaired by asking the sender to re-encrypt (client-to-client recovery). */
export function isRecoverable(f: DecryptFailure): boolean {
    return f === "hard-gap" || f === "no-session" || f === "wrong-device" || f === "unknown"; // corrupt/duplicate never re-request
}

/** Whether the failure means the sender addressed a device that isn't us — it should re-resolve our roster
 * (send a rekey hint), in addition to the message being recovered. */
export function isWrongDevice(f: DecryptFailure): boolean {
    return f === "wrong-device";
}

// What the user sees for a secret message, as a small closed set — never the guessy raw error.
export type SecretMsgState =
    | "decrypting"    // transient: live decrypt in flight
    | "pending"       // couldn't decrypt yet; re-requested from the sender, will retry (⏳)
    | "expired"       // aged out of the local retention window (disappearing messages) — NOT a failure (🕗)
    | "lost"          // every attempt to decrypt/recover failed within the window (🔒 Lost)
    | "unavailable";  // we hold no plaintext and can't recover it (e.g. own message we can't ratchet) (🔒)

const STATE_KEY: Record<SecretMsgState, string> = {
    decrypting: "chat.decrypting",
    pending: "chat.decryptPending",
    expired: "chat.decryptExpired",
    lost: "chat.decryptLost",
    unavailable: "chat.decryptUnavailable",
};

/** The i18n key for a crypto state — the ONE place chat/recovery code turns a state into a string. */
export function secretStateKey(state: SecretMsgState): string {
    return STATE_KEY[state];
}
