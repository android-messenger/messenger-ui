/**
 * Parse a call-back deep link from a push notification's URL params. The SW (public/push-sw.js) builds
 *   ?call=<conversationId>&caller=<callerUserId>
 * on an incoming-call notification tap. We call the caller back (the original WebRTC offer is stale by
 * the time the app opens), and we already KNOW the conversationId here — so it must be carried into the
 * call, or a cold start (getChats not loaded yet) fails the "do we have a conversation?" guard and shows
 * "open a chat with this contact first". Returns null when the params aren't a complete call link.
 */
export function parseCallDeepLink(params: URLSearchParams): { peerId: string; conversationId: string; media?: "audio" | "video" } | null {
    const conversationId = params.get("call");
    const peerId = params.get("caller");
    if (!conversationId || !peerId) return null;
    // Optional: the caller's media choice, if the push carried it. Lets the glare-callback fallback keep
    // an audio call audio (otherwise it would default to video). Absent → left undefined.
    const m = params.get("media");
    const media = m === "audio" || m === "video" ? m : undefined;
    // Nothing in the address can say "already accepted": a link is something anybody can send. In the
    // Android app that answer comes from the native screen (features/call/model/nativeAccept.ts).
    return { peerId, conversationId, media };
}
