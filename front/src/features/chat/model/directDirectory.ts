import {chatApi} from "@/features/chat/rest/chatApi.ts";
import type {ChatSummary} from "@/entities/conversation";

// Loose structural state — this runs from BOTH the feature middleware (RootState) and store.ts's
// dep-injection (which can't name RootState: it's derived FROM the store → circular type ref).
type DirState = {
    user?: { id?: string };
    stickyChats?: { byId?: Record<string, ChatSummary> };
};

/**
 * The DIRECT-chat directory as the UI actually sees it: the backend's /api/chats list UNION the
 * sticky-remembered chats it hides once they go empty (same merge useContacts does for the list).
 * Calls MUST resolve their peer + conversationId from THIS union, not raw getChats — otherwise an
 * open-but-empty chat (present via sticky, absent from /api/chats) can't be called even though it's
 * on screen. Groups are excluded: 1:1 calls only.
 */
export function selectDirectSummaries(state: DirState): ChatSummary[] {
    const myId = state.user?.id;
    const backend = (myId
        ? chatApi.endpoints.getChats.select({myId})(state as never)?.data ?? []
        : []) as ChatSummary[];
    const backendIds = new Set(backend.map((s) => s.conversationId));
    const sticky = Object.values(state.stickyChats?.byId ?? {}).filter((s) => !backendIds.has(s.conversationId));
    return [...backend, ...sticky].filter((s) => s.kind !== "group");
}

/** conversationId for a 1:1 call to this peer USER id, from the union directory (undefined if none). */
export function selectCallConversationId(state: DirState, peerUserId: string): string | undefined {
    return selectDirectSummaries(state).find((s) => s.counterpartId === peerUserId)?.conversationId;
}
