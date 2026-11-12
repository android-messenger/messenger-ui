import {useCallback, useMemo, useState, useEffect, useRef} from "react";
import {useDispatch, useSelector} from "react-redux";
import {setSelectedChatId} from "@/features/chat/model/slices/chatUiSlice";
import {rememberSticky, forgetSticky} from "@/features/chat/model/slices/stickyChatsSlice";
import {chatApi} from "@/features/chat/rest/chatApi.ts";
import {reconcileOrphanCaches} from "@/features/chat/db/orphanGc.ts";
import type {AppDispatch, RootState} from "@/store/store";

import {useChatMessages} from "./useChatMessages";
import {useChatAttachments} from "./useChatAttachments";
import {useUnreadChats} from "./useUnreadChats";
import {useReadReceipts} from "./useReadReceipts";
import {useReconnectCatchup} from "./useReconnectCatchup";
import {useOutboxStatus} from "./useOutboxStatus";
import {useChatModeration} from "./useChatModeration";
import {useMessageComposer} from "./useMessageComposer";
import {useContacts} from "../../contacts/hooks/useContacts.ts";

import {logger} from "@/shared/logger/logger.ts";
import type {Contact} from "@/entities/contact";


export function useChat() {
    const dispatch = useDispatch<AppDispatch>();

    /* ======================
       UI state (local)
    ====================== */
    const [searchQuery, setSearchQuery] = useState("");

    /* ======================
       Global state
    ====================== */
    const myId = useSelector((state: RootState) => state.user.id);
    const selectedChatId = useSelector(
        (state: RootState) => state.chatUi.selectedChatId
    );

    /* ======================
       Contacts (chat list from GET /api/chats)
    ====================== */
    const {contacts, summaries, getContactById, getSummary, isLoadingIds, isErrorIds} = useContacts();

    // One-shot orphan cache sweep: once the authoritative chat list has loaded (logged in, settled, no
    // error), purge locally-cached history / attachment blobs / secret plaintext for conversations that no
    // longer exist — deleted chats whose immediate cleanup was missed, or chats deleted on another device.
    // Guarded to run only against a COMPLETE, successful list (never while loading or errored, which would
    // wrongly evict live chats). Ref-guarded so it runs a single time per mount.
    const sweptOrphans = useRef(false);
    useEffect(() => {
        if (sweptOrphans.current) return;
        if (!myId || isLoadingIds || isErrorIds) return;
        sweptOrphans.current = true;
        const liveIds = new Set(summaries.map((s) => s.conversationId));
        void reconcileOrphanCaches(liveIds);
    }, [myId, isLoadingIds, isErrorIds, summaries]);

    // Close a chat whose conversation is no longer in the (loaded) list — e.g. a soft-deleted/empty
    // chat the backend transiently lists then drops on a getChats refetch. Without this, ChatWindow
    // stays open (isChatOpen keys off selectedChatId) but getContactById/getSummary return null → no
    // counterpart name and a dead composer, silently with no error.
    useEffect(() => {
        if (!selectedChatId || isLoadingIds) return;
        if (!summaries.some((s) => s.conversationId === selectedChatId)) {
            logger.warn("selected chat not in the loaded list — closing (was a silent dead window)", {selectedChatId});
            dispatch(setSelectedChatId(null));
        }
    }, [selectedChatId, summaries, isLoadingIds, dispatch]);

    // Remember an opened DIRECT chat so it stays in the list even after it goes empty (the backend hides
    // message-less conversations from /api/chats). Re-storing the same summary is an Immer no-op, so this
    // settles (no loop) even though remembering feeds back into `summaries` → getSummary; a getChats
    // refetch just refreshes the stored snapshot once.
    useEffect(() => {
        if (!selectedChatId) return;
        const s = getSummary(selectedChatId);
        if (s && s.kind !== "group") dispatch(rememberSticky(s));
    }, [selectedChatId, getSummary, dispatch]);

    // Declared before the handlers that reference them (reloadChatHistory/clearChat/markRead).
    const {unreadChats, markRead} = useUnreadChats();
    const {messages, loadingHistory, isError: historyError, reloadChatHistory, clearChat} = useChatMessages();

    // Attachment lifecycle (upload/download/resolve + progress) lives in its own hook.
    const {uploadProgress, sendAttachment, downloadAttachment, getAttachmentUrl} =
        useChatAttachments(selectedChatId, reloadChatHistory);

    const filteredChats = useMemo(
        () =>
            contacts.filter((c) =>
                c.name.toLowerCase().includes(searchQuery.toLowerCase())
            ),
        [contacts, searchQuery]
    );

    const selectedChat: Contact | null = useMemo(
        () => (selectedChatId ? getContactById(selectedChatId) : null),
        [selectedChatId, getContactById]
    );

    // The counterpart's USER id (for WebRTC signaling recipientId) — distinct from the
    // conversationId used as the chat/list key.
    const selectedCounterpartId = useMemo(
        () => (selectedChatId ? getSummary(selectedChatId)?.counterpartId ?? null : null),
        [selectedChatId, getSummary]
    );
    // Whether the open conversation is a GROUP — drives group rendering (author labels, no ✓✓,
    // no call/block, group header) across ChatWindow.
    const selectedIsGroup = useMemo(
        () => (selectedChatId ? getSummary(selectedChatId)?.kind === "group" : false),
        [selectedChatId, getSummary]
    );
    // Moderation (block flags + toggleBlock + deleteMessage) lives in its own hook.
    const {selectedBlocked, selectedBlockedByMe, selectedBlockedByPeer, toggleBlock, deleteMessage} =
        useChatModeration({selectedChatId, getSummary});

    // Incoming CHAT_OUT / CHAT_ACK / READ_OUT / TYPING_OUT are handled per-frame in chatMiddleware
    // (not a lastIncoming effect), so bursts of frames are never dropped.

    // Reconnect / resume catch-up (refresh list + open history on ws reconnect and on resume from
    // background) lives in its own hook.
    useReconnectCatchup({selectedChatId, reloadChatHistory});

    // Read-receipt (READ_IN) machinery lives in its own hook (boundary reader + the visible/connect/
    // newest triggers). It hands back the boundary reader and a sender for openChat.
    const newestMessageId = messages.length ? messages[messages.length - 1].id : null;
    const {sendReadReceipt} = useReadReceipts({selectedChatId, newestMessageId, getSummary, markRead});

    /* ======================
       Actions (memoized so <ChatWindow>/<ChatList> can be React.memo'd)
    ====================== */
    const openChat = useCallback(async (chatId: string) => {
        dispatch(setSelectedChatId(chatId));
        markRead(chatId);
        // Mark the conversation read on open (peer receives READ_OUT).
        sendReadReceipt(chatId);
    }, [dispatch, markRead, sendReadReceipt]);

    const deleteChat = useCallback(async () => {
        const id = selectedChatId;
        if (id) {
            // Explicit delete: forget it as sticky AND optimistically drop it from the list cache, so
            // the "remember opened chat" effect can't re-add it as a sticky (empty) chat before the
            // backend refetch lands — otherwise a deleted chat reappears empty.
            dispatch(forgetSticky(id));
            dispatch(chatApi.util.updateQueryData("getChats", {myId}, (draft) => {
                const i = draft.findIndex((s) => s.conversationId === id);
                if (i >= 0) draft.splice(i, 1);
            }));
        }
        await clearChat();
        dispatch(setSelectedChatId(null));
    }, [clearChat, dispatch, selectedChatId, myId]);

    // Outbox delivery status (per-message 🕐 / ⚠ + retry/discard) lives in its own hook.
    const {outboxStatusById, retryMessage, discardMessage} = useOutboxStatus({selectedChatId, myId});

    // Composer state + send + typing notifier live in their own hook.
    const {messageInput, setMessageInput, sendMessage, forwardMessage, notifyTyping} =
        useMessageComposer({selectedChatId, myId, getSummary});

    return {
        contacts,
        filteredChats,
        selectedChat,
        selectedChatId,
        selectedCounterpartId,
        selectedIsGroup,
        selectedBlocked,
        selectedBlockedByMe,
        selectedBlockedByPeer,
        toggleBlock,
        deleteMessage,
        sendAttachment,
        uploadProgress,
        downloadAttachment,
        getAttachmentUrl,
        notifyTyping,
        messageInput,
        setMessageInput,
        searchQuery,
        setSearchQuery,
        openChat,
        sendMessage,
        forwardMessage,
        deleteChat,
        unreadChats,
        messages,
        loadingHistory,
        historyError,
        reloadChatHistory,
        outboxStatusById,
        retryMessage,
        discardMessage,
    };
}
