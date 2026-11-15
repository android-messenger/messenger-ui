import {createApi, fetchBaseQuery} from "@reduxjs/toolkit/query/react";
import {type ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema.ts";
import {MESSENGER_API} from "@/shared/config/api.ts";
import {HISTORY_PAGE_SIZE} from "@/shared/config/chat.ts";
import {saveHistoryToDB} from "@/features/chat/db/db.ts";
import {toMessages} from "@/features/chat/model/reconcileHistory.ts";
import {rowRemoved, rowRestored, selectRows, type ChatHistoryState} from "@/features/chat/model/slices/chatHistorySlice.ts";
import {toChatSummary, type RawConversation, type ChatSummary} from "@/entities/conversation";

/** Raw backend Conversation (GET /api/chats) — internal to this api's transformResponse. */
type Conversation = {
    id: string;
    clientId: string;
    masterId: string;
    metadata?: Record<string, string> | null;
    clientBlocked?: boolean;
    masterBlocked?: boolean;
    // Durable read boundary per side: the messageId (server ULID) each participant last read up to.
    clientReadReceipt?: string | null;
    masterReadReceipt?: string | null;
};

export const chatApi = createApi({
    reducerPath: "chatApi",
    baseQuery: fetchBaseQuery({
        baseUrl: MESSENGER_API,
        credentials: "include",
    }),
    tagTypes: ["Chats", "Chat"],
    endpoints: (builder) => ({

        // --------------------
        // Caller's conversations (recent-first). Identity comes from the edge headers.
        // --------------------
        getChats: builder.query<ChatSummary[], { myId: string }>({
            query: () => `/chats`,
            // The list is DIRECT chats ∪ the caller's active GROUPS (merged server-side, ADR-024). Each
            // row maps to a caller-relative ChatSummary; toChatSummary discriminates DIRECT vs GROUP.
            transformResponse: (response: unknown, _meta, arg): ChatSummary[] => {
                if (!Array.isArray(response)) return [];
                return (response as RawConversation[]).map((c) => toChatSummary(c, arg.myId));
            },
            providesTags: ["Chats"],
        }),

        // The chat's newest message only — for the "unread" mark (spec 002 §3.2). A GET declared as a
        // "mutation", as getHistoryPage below: the answer is handed to the caller and kept nowhere. As a
        // query, a request made while the previous connection's request for the same chat was still on
        // its way was not sent at all.
        getLastMessage: builder.mutation<ChatMessage | null, { chatId: string }>({
            query: ({chatId}) => `/chats/${chatId}/messages?limit=1`,
            transformResponse: (response: unknown): ChatMessage | null => toMessages(response).at(-1) ?? null,
        }),

        // The newest page of the chat's history as the server gave it (backend default = latest `limit`,
        // ASC) — for the readHistory thunk (spec 003, story 2), which merges it into the chatHistory
        // slice. Older pages are pulled by the loadOlderHistory thunk (`?before=<oldest>`).
        // A GET declared as a "mutation": the answer is handed to the caller and kept nowhere — the
        // messages live in the slice. As a query with no subscriber its cache entry was dropped while
        // the next request was on its way, and that request came back with no data at all.
        getHistoryPage: builder.mutation<unknown, { chatId: string }>({
            query: ({chatId}) => `/chats/${chatId}/messages?limit=${HISTORY_PAGE_SIZE}`,
        }),

        // --------------------
        // Soft-delete the conversation for the caller (reversible by new activity).
        // --------------------
        deleteChatHistory: builder.mutation<
            void,
            { myId: string; chatId: string }
        >({
            query: ({chatId}) => ({
                url: `/chats/${chatId}`,
                method: "DELETE",
            }),
            // Invalidate the chat list (Chats): the backend excludes soft-deleted conversations from
            // GET /chats, so refetching the list drops the deleted chat from the UI. The chat's rows are
            // emptied by the caller (chatMessagesService.clearChatHistory).
            invalidatesTags: ["Chats"],
        }),

        // --------------------
        // Bulk read receipt (reconnect/fallback; primary path is WS READ_IN). Per the backend
        // contract: POST /api/chats/{id}/read?lastReadId=<serverMessageId> — the boundary MUST be a
        // server ULID (not a local id); the server advances the watermark monotonically.
        // --------------------
        markRead: builder.mutation<
            void,
            { myId: string; chatId: string; lastReadId?: string }
        >({
            query: ({chatId, lastReadId}) => ({
                url: lastReadId
                    ? `/chats/${chatId}/read?lastReadId=${encodeURIComponent(lastReadId)}`
                    : `/chats/${chatId}/read`,
                method: "POST",
            }),
        }),

        // --------------------
        // Create/return a conversation (idempotent on the pair). Backend gates this to
        // ADMIN/SERVICE (403 otherwise) — chats are normally provisioned by the platform.
        // --------------------
        createChat: builder.mutation<
            Conversation,
            { clientId: string; masterId: string; metadata?: Record<string, string> }
        >({
            query: (body) => ({
                url: `/chats`,
                method: "POST",
                body: { ...body, metadata: body.metadata ?? {} },
                // No admin key: the backend lets a signed-in user create a chat they are part of
                // (android-messenger docs security/14 Э2-1).
            }),
            // Do NOT invalidate "Chats": createChat is idempotent on the pair and may return a
            // conversation the caller previously soft-deleted (getChats hides it until a message
            // revives it). AddUser injects the returned conversation into the getChats cache and opens
            // it so the user can send the first message (which revives it). A "Chats" refetch here
            // would immediately drop that still-hidden conversation back out of the list — the chat
            // fails to open and "the list doesn't grow". The manual inject is the source of truth.
        }),

        // Block / unblock the peer (mutual; the only terminal messaging stop). Optimistically flip
        // MY block flag in the getChats cache so the UI reacts instantly; undo on failure.
        blockChat: builder.mutation<void, { chatId: string }>({
            query: ({ chatId }) => ({ url: `/chats/${chatId}/block`, method: "POST" }),
            // No "Chats" invalidation: the optimistic patch already flips the flag, and a refetch here
            // would drop a soft-deleted-but-transiently-listed conversation out of the list — the
            // blocked chat would vanish and you could no longer unblock it.
            async onQueryStarted({ chatId }, { dispatch, getState, queryFulfilled }) {
                const myId = (getState() as { user?: { id?: string } })?.user?.id;
                if (!myId) return;
                const patch = dispatch(chatApi.util.updateQueryData("getChats", { myId }, (draft) => {
                    const s = draft.find((c) => c.conversationId === chatId);
                    if (s) { s.blockedByMe = true; s.blocked = true; }
                }));
                try { await queryFulfilled; } catch { patch.undo(); }
            },
        }),
        unblockChat: builder.mutation<void, { chatId: string }>({
            query: ({ chatId }) => ({ url: `/chats/${chatId}/block`, method: "DELETE" }),
            // No "Chats" invalidation (see blockChat): the optimistic patch flips the flag; a refetch
            // could drop a transiently-listed soft-deleted conversation from the list.
            async onQueryStarted({ chatId }, { dispatch, getState, queryFulfilled }) {
                const myId = (getState() as { user?: { id?: string } })?.user?.id;
                if (!myId) return;
                const patch = dispatch(chatApi.util.updateQueryData("getChats", { myId }, (draft) => {
                    const s = draft.find((c) => c.conversationId === chatId);
                    if (s) { s.blockedByMe = false; s.blocked = s.blockedByPeer; }
                }));
                try { await queryFulfilled; } catch { patch.undo(); }
            },
        }),

        // Delete a single message by BOTH ids (only if not frozen → 409). The backend matches on the
        // server ULID (backendId) if present, else the original client id (clientMessageId) — so a
        // just-sent message that hasn't reconciled its id yet still deletes without a history refetch.
        deleteMessage: builder.mutation<void, { chatId: string; backendId?: string; clientMessageId?: string }>({
            query: ({ chatId, backendId, clientMessageId }) => {
                const q = new URLSearchParams();
                if (backendId) q.set("backendId", backendId);
                if (clientMessageId) q.set("clientMessageId", clientMessageId);
                return { url: `/chats/${chatId}/messages?${q.toString()}`, method: "DELETE" };
            },
            // Take the one row out of the chat at once — the history is not read again for it. Match on
            // the server ULID (backendId → m.id) OR the original client id (clientMessageId →
            // m.clientId/m.id), so a not-yet-reconciled message deletes locally too. The row goes back if
            // the request fails.
            async onQueryStarted({ chatId, backendId, clientMessageId }, { dispatch, getState, queryFulfilled }) {
                const rows = () => selectRows(getState() as unknown as {chatHistory: ChatHistoryState}, chatId);
                const index = rows()?.findIndex((m) =>
                    (!!backendId && m.id === backendId) ||
                    (!!clientMessageId && (m.clientId === clientMessageId || m.id === clientMessageId))) ?? -1;
                const row = index >= 0 ? rows()![index] : undefined;
                if (row) dispatch(rowRemoved({chatId, id: row.id}));
                try {
                    await queryFulfilled;
                    // The device's copy now, not when the chat leaves the screen: if the app is killed
                    // before that, the deleted message would be back offline. The rows hold decrypted
                    // secret text; saveHistoryToDB leaves it out.
                    const now = rows();
                    if (now) saveHistoryToDB(chatId, now).catch(() => { /* best-effort */ });
                } catch {
                    if (row) dispatch(rowRestored({chatId, row, index}));
                }
            },
        }),

        // Attachments (two-phase presigned upload, ADR-010).
        attachmentUploadUrl: builder.mutation<
            { attachmentId: string; objectKey: string; uploadUrl: string; method: string; expiresAt: string },
            { chatId: string; fileName: string; contentType: string; sizeBytes: number }
        >({
            query: ({ chatId, fileName, contentType, sizeBytes }) => ({
                url: `/chats/${chatId}/attachments/upload-url`,
                method: "POST",
                body: { fileName, contentType, sizeBytes },
            }),
        }),
        attachmentConfirm: builder.mutation<
            { status: string },
            { chatId: string; attachmentId: string }
        >({
            query: ({ chatId, attachmentId }) => ({
                url: `/chats/${chatId}/attachments/${attachmentId}/confirm`,
                method: "POST",
            }),
        }),
        attachmentDownloadUrl: builder.mutation<
            { downloadUrl: string; method: string; expiresAt: string },
            { chatId: string; attachmentId: string }
        >({
            query: ({ chatId, attachmentId }) => ({
                url: `/chats/${chatId}/attachments/${attachmentId}/download-url`,
                method: "GET",
            }),
        }),

        // --------------------
        // Presence status for ONE user (the open chat's counterpart) — online flag + last-seen.
        // `lastSeen` is UTC epoch millis, null while online / never recorded / retention expired.
        // The live WS PRESENT_* frames only carry online/offline transitions (no timestamp), so this
        // REST read is the only source of the "last seen {time}" the header shows when a peer is
        // offline. Rendered in the viewer's own local timezone.
        getPresenceStatus: builder.query<
            { id: string; online: boolean; lastSeen: number | null },
            string
        >({
            query: (id) => `/presence/${id}`,
        }),
    }),
});

// --------------------
// Auto-generated service
// --------------------
export const {
    useGetChatsQuery,
    useDeleteChatHistoryMutation,
    useMarkReadMutation,
    useCreateChatMutation,
    useBlockChatMutation,
    useUnblockChatMutation,
    useDeleteMessageMutation,
    useAttachmentUploadUrlMutation,
    useAttachmentConfirmMutation,
    useAttachmentDownloadUrlMutation,
    useGetPresenceStatusQuery,
} = chatApi;
