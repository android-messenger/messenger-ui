// «Принять» on the app's native incoming-call screen (S1 §7.3). The answer comes as an event of the
// app's Push plugin and is kept here, in memory — never in the address bar: a link can be sent by
// anybody, and `?accept=1` in it used to switch on auto-answer for the sender's next call
// (audit 2026-11-12, finding Б). One accepted call at a time, used once, for a short while.

/** The native screen rings for 45 s; the caller's re-sent offer follows the answer within seconds. */
export const NATIVE_ACCEPT_TTL_MS = 45_000;

let accepted: {peerId: string; conversationId: string; until: number} | null = null;

/** The Push plugin said: the user accepted this caller's call on the native screen. */
export function noteNativeAccept(peerId: string, conversationId: string, now = Date.now()): void {
    accepted = {peerId, conversationId, until: now + NATIVE_ACCEPT_TTL_MS};
}

/** True once, for the call that was accepted on the native screen and is still fresh. */
export function takeNativeAccept(peerId: string, conversationId: string, now = Date.now()): boolean {
    const a = accepted;
    if (!a || a.peerId !== peerId || a.conversationId !== conversationId) return false;
    accepted = null;
    return now < a.until;
}
