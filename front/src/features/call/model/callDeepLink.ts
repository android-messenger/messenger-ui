/**
 * Parse a call-back deep link from a push notification's URL params. The SW (public/push-sw.js) builds
 *   ?call=<conversationId>&caller=<callerUserId>
 * on an incoming-call notification tap. We call the caller back (the original WebRTC offer is stale by
 * the time the app opens), and we already KNOW the conversationId here — so it must be carried into the
 * call, or a cold start (getChats not loaded yet) fails the "do we have a conversation?" guard and shows
 * "open a chat with this contact first". Returns null when the params aren't a complete call link.
 */
export function parseCallDeepLink(params: URLSearchParams): { peerId: string; conversationId: string; media?: "audio" | "video"; autoAccept?: boolean } | null {
    const conversationId = params.get("call");
    const peerId = params.get("caller");
    if (!conversationId || !peerId) return null;
    // Optional: the caller's media choice, if the push carried it. Lets the glare-callback fallback keep
    // an audio call audio (otherwise it would default to video). Absent → left undefined.
    const m = params.get("media");
    const media = m === "audio" || m === "video" ? m : undefined;
    // Android app (S1 §7.3): `accept=1` — the user already pressed «Принять» on the native incoming-call
    // screen, so the caller's re-sent offer is answered without a second in-app dialog.
    return params.get("accept") === "1" ? { peerId, conversationId, media, autoAccept: true } : { peerId, conversationId, media };
}
