import {logger} from "@/shared/logger/logger.ts";
import {liveEpoch, noteHistoryRead} from "@/features/chat/model/historySync.ts";
import {createApi, fetchBaseQuery} from "@reduxjs/toolkit/query/react";
import {type ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema.ts";
import type {OutboxMessage} from "@/features/chat/model/types.ts";
import {MESSENGER_API} from "@/shared/config/api.ts";
import {HISTORY_PAGE_SIZE} from "@/shared/config/chat.ts";
import {loadHistoryFromDB, saveHistoryToDB} from "@/features/chat/db/db.ts";
import {setPeerLastReadId} from "@/features/chat/model/slices/chatUiSlice.ts";
import {toMessages, dedupMessages} from "@/features/chat/model/reconcileHistory.ts";
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

        // --------------------
        // Conversation history (cursor-paginated). chatId === conversationId.
        // --------------------
        // Loads the NEWEST page (backend default = latest `limit`, ASC). Older pages are pulled on
        // demand by the loadOlderHistory thunk (`?before=<oldest>`), which prepends into this cache;
        // reconnect catch-up appends newer via `?since=`. Rendering is windowed downstream.
        getChatHistory: builder.query<
            ChatMessage[],
            { myId: string; chatId: string }
        >({
            async queryFn({myId, chatId}, api, _extra, baseQuery) {
                // Spec 002 §3.1: the connection of the socket this read starts under (null — not connected).
                const wsOf = () => (api.getState() as {ws?: {status?: string; epoch?: number}}).ws;
                const startedUnder = liveEpoch(wsOf());
                const res = await baseQuery(`/chats/${chatId}/messages?limit=${HISTORY_PAGE_SIZE}`);
                // A 404 = a conversation with no message backing yet (e.g. a group whose history endpoint
                // isn't wired). Treat it as EMPTY, not an error — an errored query leaves RTK's `data`
                // holding the PREVIOUSLY opened chat's rows, which then render in the new (group) window
                // (the "1:1 messages leaked into the group" bug). Fall THROUGH (raw=undefined → [] rows)
                // so the outbox re-graft below still runs and a just-sent pending group message survives.
                if (res.error && (res.error as {status?: number}).status !== 404) {
                    logger.info("sync: history read failed", {chatId, status: (res.error as {status?: unknown}).status});
                    return {error: res.error};
                }
                const raw = res.error ? undefined : res.data;
                const messages = dedupMessages(toMessages(raw));
                const proved = noteHistoryRead(chatId, startedUnder, wsOf());
                logger.info("sync: history read", {chatId, rows: messages.length, complete: proved});
                // Read while the socket was down or changing, and it is up now: the answer may miss what came
                // in between. Read once more under the live connection (after this request has settled).
                if (!proved && liveEpoch(wsOf()) !== null) {
                    setTimeout(() => { void api.dispatch(chatApi.endpoints.getChatHistory.initiate({myId, chatId}, {forceRefetch: true, subscribe: false})); }, 0);
                }

                // ✓✓ source of truth (backend contract): the response is an envelope
                // { messages, peerLastReadId } where peerLastReadId is the peer's read watermark
                // (a server ULID, or null/legacy). Feed it to chatUi so my messages with
                // serverMessageId <= peerLastReadId render ✓✓. ULID-guarded + monotonic in the reducer,
                // so a null or legacy non-ULID watermark is simply ignored (no false ✓✓).
                const peerLastReadId = (raw as { peerLastReadId?: string | null } | undefined)?.peerLastReadId;
                if (peerLastReadId) api.dispatch(setPeerLastReadId({chatId, lastReadId: peerLastReadId}));

                // Re-graft still-queued outbox messages for this chat. A forceRefetch REPLACES the
                // cache array, wiping the optimistic echoes of not-yet-acked messages; the CHAT_ACK
                // handler only updates an existing row (never re-inserts), so without this a pending
                // message would vanish from the sender's transcript on reconnect / after sending an
                // attachment (both call reloadChatHistory). Everything still in the outbox is by
                // definition un-acked (markSent removes it on ACK), so it isn't in the server rows yet
                // → append it, skipping any id already present.
                const outbox = (api.getState() as { outbox?: { messages?: OutboxMessage[] } }).outbox?.messages ?? [];
                const present = new Set(messages.map((m) => m.id));
                // Server rows carry no client id, so an un-acked outbox echo can't be matched to its
                // OWN server row by id — if the message was stored server-side but its ACK was lost, a
                // refetch would show it twice (server ULID row + client echo). Dedup by content: if a
                // server row from me already has this text+kind, the message was delivered — skip the echo.
                const mineServer = new Set(
                    messages.filter((m) => m.from === myId).map((m) => `${m.kind ?? ""}\0${m.text}`)
                );
                for (const o of outbox) {
                    const p = o.payload;
                    if (p?.conversationId !== chatId || present.has(o.id)) continue;
                    if (mineServer.has(`${p.payload?.kind ?? ""}\0${p.payload?.body ?? ""}`)) continue;
                    messages.push({
                        id: o.id,
                        clientId: o.id,
                        chatId,
                        from: myId,
                        to: p.recipientId ?? "",
                        text: p.payload?.body ?? "",
                        createdAt: new Date(p.senderTimestamp ?? Date.now()),
                        status: o.status,
                        kind: p.payload?.kind,
                        meta: p.meta,
                    });
                }
                return {data: messages};
            },
            providesTags: (_r, _e, arg) => [
                {type: "Chat", id: arg.chatId},
            ],
            // Offline/instant-open cache in IndexedDB: seed from the local cache immediately (so the
            // chat opens without waiting for the network), then persist the fresh result and, on
            // unsubscribe, the final in-memory state (incl. messages that arrived while open).
            // Only what toDiskRows lets through reaches the disk: secret (E2EE) rows are dropped inside
            // saveHistoryToDB / loadHistoryFromDB, so the in-memory array can be passed as is.
            async onCacheEntryAdded(arg, {updateCachedData, cacheDataLoaded, cacheEntryRemoved, getCacheEntry}) {
                try {
                    const cached = await loadHistoryFromDB(arg.chatId);
                    if (cached && cached.length) {
                        updateCachedData((draft) => {
                            // Seed only while the network hasn't populated the entry yet.
                            if (!Array.isArray(draft) || draft.length === 0) return cached;
                        });
                    }
                } catch { /* cache read is best-effort */ }
                try {
                    await cacheDataLoaded;
                    const data = getCacheEntry().data;
                    if (data) await saveHistoryToDB(arg.chatId, data);
                } catch { /* subscription aborted before first load */ }
                try {
                    await cacheEntryRemoved;
                    const data = getCacheEntry().data;
                    if (data) await saveHistoryToDB(arg.chatId, data);
                } catch { /* ignore */ }
            },
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
            // Invalidate BOTH the history (Chat/id) AND the chat list (Chats): the backend excludes
            // soft-deleted conversations from GET /chats, so refetching the list drops the deleted
            // chat from the UI. Without the "Chats" tag the list query never refetches and the
            // deleted chat lingers in the sidebar.
            invalidatesTags: (_r, _e, arg) => [
                {type: "Chat", id: arg.chatId},
                "Chats",
            ],
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
            // Remove the one message from the history cache in place — do NOT invalidate the "Chat"
            // tag. An invalidation forces getChatHistory to refetch the ENTIRE conversation just to
            // drop a single row (the exact refetch we were trying to avoid). Match on the server ULID
            // (backendId → m.id) OR the original client id (clientMessageId → m.clientId/m.id), so a
            // not-yet-reconciled message deletes locally too. Undo the patch if the request fails.
            async onQueryStarted({ chatId, backendId, clientMessageId }, { dispatch, getState, queryFulfilled }) {
                const myId = (getState() as { user?: { id?: string } })?.user?.id;
                if (!myId) return;
                const patch = dispatch(chatApi.util.updateQueryData("getChatHistory", { myId, chatId }, (draft) => {
                    if (!Array.isArray(draft)) return;
                    const i = draft.findIndex((m) =>
                        (backendId && m.id === backendId) ||
                        (clientMessageId && (m.clientId === clientMessageId || m.id === clientMessageId)));
                    if (i >= 0) draft.splice(i, 1);
                }));
                try {
                    await queryFulfilled;
                    // Persist the post-delete list now. The IndexedDB seed is otherwise only rewritten
                    // on cacheEntryRemoved (unsubscribe); if the tab is hard-closed before then, the
                    // stale pre-delete array would re-seed and the deleted message would reappear offline.
                    // The in-memory array holds decrypted secret rows; saveHistoryToDB filters them out.
                    const data = chatApi.endpoints.getChatHistory.select({ myId, chatId })(getState() as never)?.data;
                    if (data) saveHistoryToDB(chatId, data).catch(() => { /* best-effort */ });
                } catch { patch.undo(); }
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
    useLazyGetChatHistoryQuery,
    useGetChatHistoryQuery,
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
