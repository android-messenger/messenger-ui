import type {NotificationTapData} from "@/shared/platform.ts";

/** Route for a notification tap (exported for tests). */
export function tapRoute(d: NotificationTapData): string | null {
    if (d.call?.conversationId && d.call.callerId) {
        const q = new URLSearchParams({call: d.call.conversationId, caller: d.call.callerId});
        if (d.call.media) q.set("media", d.call.media);
        if (d.call.accept) q.set("accept", "1");   // S1 §7.3: already accepted on the native screen
        return `/?${q.toString()}`;
    }
    if (d.conversationId) return `/?${new URLSearchParams({chat: d.conversationId}).toString()}`;
    return null;
}
