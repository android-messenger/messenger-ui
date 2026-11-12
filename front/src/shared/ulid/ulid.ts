// ULID helpers. A ULID is 26 chars of Crockford base32: the first 10 chars encode a 48-bit
// millisecond timestamp, the last 16 are randomness. Lexicographic order == chronological order.
//
// We use these to turn a server-issued message id (a ULID) into its embedded timestamp, so the
// durable read boundary from GET /chats (`{client,master}ReadReceipt`, a ULID) can be compared
// against a message's createdAt WITHOUT needing that boundary message to be loaded locally — and
// without depending on our own just-sent messages having been reconciled from their temporary
// client id to the server ULID yet.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // excludes I, L, O, U
const ULID_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

/** True if `s` is a well-formed 26-char Crockford-base32 ULID (our temporary client ids are not). */
export function isUlid(s: string | undefined | null): s is string {
    return typeof s === "string" && ULID_RE.test(s.toUpperCase());
}

/**
 * Epoch-ms encoded in a ULID's first 10 chars, or NaN if `s` isn't a ULID (e.g. a nanoid client id).
 * NaN is intentional: callers compare with `<=`, and any comparison against NaN is false, so a
 * non-ULID boundary simply yields "not read" rather than a bogus match.
 */
export function ulidTimeMs(s: string | undefined | null): number {
    if (!isUlid(s)) return NaN;
    const u = s.toUpperCase();
    let t = 0;
    for (let i = 0; i < 10; i++) {
        const v = CROCKFORD.indexOf(u[i]);
        if (v < 0) return NaN;
        t = t * 32 + v;
    }
    return t;
}
