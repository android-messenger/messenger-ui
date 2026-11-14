import type {ChatSummary} from "@/entities/conversation";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema.ts";
import {isUlid} from "@/shared/ulid/ulid.ts";

// Spec 002 §3.2 — the "unread" mark comes from the server, not only from a socket frame.
//
// A chat is unread if its last message is not mine and is newer than my read position. The chat list
// carries my read position; the history gives the last message by a short request. Asked after every
// connection of the socket — that is, after every gap — so the mark is there after a push, after a push
// that was lost, and after a cold start.

/** How many chats are asked after one connection, and how many requests run at once. */
export const UNREAD_PROBE_MAX_CHATS = 50;
export const UNREAD_PROBE_PARALLEL = 4;

/** True if `last` (the chat's newest message) is something I have not read. */
export function isUnread(last: Pick<ChatMessage, "id" | "from"> | undefined, myId: string, myReadId: string | undefined): boolean {
    if (!last || last.from === myId) return false;
    if (!isUlid(last.id)) return false;                        // not a stored message: nothing to compare
    if (!isUlid(myReadId)) return true;                        // never read anything here
    return last.id.toUpperCase() > myReadId.toUpperCase();     // ULIDs sort by time
}

/** The chats to ask: direct ones (a group's list carries no read position), the first UNREAD_PROBE_MAX_CHATS. */
export function chatsToProbe(chats: ChatSummary[], skip: string | null): ChatSummary[] {
    return chats.filter((c) => c.kind === "direct" && c.conversationId !== skip).slice(0, UNREAD_PROBE_MAX_CHATS);
}

/** Runs `job` over `items`, at most `parallel` at a time. A failed job is skipped. */
export async function inBatches<T>(items: T[], parallel: number, job: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const item = items[next++];
            try { await job(item); } catch { /* this chat is asked again after the next connection */ }
        }
    };
    await Promise.all(Array.from({length: Math.min(parallel, items.length)}, worker));
}
