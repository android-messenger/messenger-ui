/** Kratos 4000010: the identity's address is not verified yet (require_verified_address). */
export const KRATOS_ADDRESS_NOT_VERIFIED = 4000010;

/** A login-flow message for the user: the unverified-address one gets an actionable text. */
export function loginMessageText(m: {id: number; text: string}, t: (k: string) => string): string {
    return m.id === KRATOS_ADDRESS_NOT_VERIFIED ? t("auth.verifyEmailFirst") : m.text;
}
