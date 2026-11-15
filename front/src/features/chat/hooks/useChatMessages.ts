import {useCallback, useEffect, useMemo} from "react";
import {useDispatch, useSelector} from "react-redux";
import {chatApi} from "@/features/chat/rest/chatApi";
import {toChatMessageView} from "@/features/chat/model/mapper";
import type {AppDispatch, RootState} from "@/store/store";
import {chatMessagesService} from "@/features/chat/model/services/chatMessages.service";
import {selectChatHistory} from "@/features/chat/model/slices/chatHistorySlice";
import {openHistory, storeHistory} from "@/features/chat/thunk/readHistory";

export function useChatMessages() {
    const myId = useSelector((state: RootState) => state.user.id);
    const dispatch = useDispatch<AppDispatch>();

    /* ======================
       Selected chat (global)
    ====================== */
    const selectedChatId = useSelector(
        (state: RootState) => state.chatUi.selectedChatId
    );

    /* ======================
       History — the chat's rows live in the chatHistory slice (spec 003, story 2). A group is read the
       SAME way as any conversation (its id IS a conversation id); a 404 (a conversation with no message
       backing yet) is an empty chat. The rows are taken per chat, so a slow switch never shows the
       previous chat's messages under the new header: until this chat has rows, the loader is shown.
    ====================== */
    const history = useSelector((state: RootState) => selectChatHistory(state, selectedChatId));
    const rows = history?.rows;
    // A failed read is shown, not swallowed: with no rows — a retryable error instead of an "empty" chat.
    const isError = !!history?.error;
    const loadingHistory = !!selectedChatId && rows === undefined && !isError;

    // Read on open; the device's copy is written when the chat leaves the screen.
    useEffect(() => {
        if (!selectedChatId) return;
        void dispatch(openHistory(selectedChatId));
        return () => { void dispatch(storeHistory(selectedChatId)); };
    }, [selectedChatId, dispatch]);

    const [deleteHistory] = chatApi.useDeleteChatHistoryMutation();

    /* ======================
       Reload (force refetch)
    ====================== */
    const reloadChatHistory = useCallback(
        async () => {
            await chatMessagesService.reloadChatHistory(dispatch, selectedChatId);
        },
        [dispatch, selectedChatId]
    );

    /* ======================
       Clear chat
    ====================== */
    const clearChat = useCallback(
        async () => {
            await chatMessagesService.clearChatHistory(dispatch, deleteHistory, myId, selectedChatId);
        },
        [deleteHistory, myId, selectedChatId, dispatch]
    );

    /* ======================
       View mapping (memoized: a fresh array every render made ChatWindow's
       scroll effect fire on every render and forced a full list reconcile).
       Sorted by createdAt so display order is chronological even if a WS frame
       arrives out of order or history isn't pre-sorted by the backend.
    ====================== */
    const messages = useMemo(
        () =>
            [...(rows ?? [])]
                .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
                .map((msg) => toChatMessageView(msg, myId)),
        [rows, myId]
    );

    return {
        messages,
        loadingHistory,
        isError,
        reloadChatHistory,
        clearChat,
    };
}
