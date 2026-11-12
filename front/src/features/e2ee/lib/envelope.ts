// The wire marker of a secret message. No imports: the history cache and message rendering read it too.

export const MARKER = "E2EE1:";                    // the browser implementation (JavaScript keys)
export const MARKER_NATIVE = "E2EE2:";             // the Android app: made by the app's library

/** True if a received wire body is an E2EE envelope of either implementation (vs. plaintext). */
export function isSecretEnvelope(body: string | undefined): boolean {
    return !!body && (body.startsWith(MARKER) || body.startsWith(MARKER_NATIVE));
}
