import type {ChatSummary} from "@/entities/conversation";

// When the chat list is refetched (on reconnect / resume) it comes straight from GET /chats, which
// HIDES conversations with no messages yet — including a just-created chat that AddUser injected into
// the cache and that is the source of truth until its first message. A blanket refetch therefore
// drops it ("the chat vanishes right after creating it"). This keeps the currently-SELECTED
// conversation visible across a refetch: if it was present before but the fresh list omits it,
// re-append the previous entry. Only the selected chat is preserved — everything else follows the
// server list.
export function preserveSelectedConversation(
    fresh: ChatSummary[],
    previous: ChatSummary[] | undefined,
    selectedId: string | null,
): ChatSummary[] {
    if (!selectedId) return fresh;
    if (fresh.some((s) => s.conversationId === selectedId)) return fresh;
    const keep = previous?.find((s) => s.conversationId === selectedId);
    return keep ? [...fresh, keep] : fresh;
}
