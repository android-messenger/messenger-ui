// The safety number itself is computed by the Android app's library (secretCrypto.safetyNumber).

/** Group the digits into readable 5-digit chunks (e.g. "12345 67890 …"). */
export function formatSafetyNumber(n: string): string {
    return (n.match(/.{1,5}/g) ?? [n]).join(" ");
}
