// The wire marker of a secret message. No imports: the history cache and message rendering read it too.

export const MARKER = "E2EE1:";                    // prefix on the wire body; version 1

/** True if a received wire body is an E2EE envelope (vs. plaintext). */
export function isSecretEnvelope(body: string | undefined): boolean {
    return !!body && body.startsWith(MARKER);
}
