import {useCallback, useEffect, useMemo} from "react";
import {useDispatch, useSelector} from "react-redux";
import {skipToken} from "@reduxjs/toolkit/query/react";

import {chatApi} from "@/features/chat/rest/chatApi";
import {toChatMessageView} from "@/features/chat/model/mapper";
import type {AppDispatch, RootState} from "@/store/store";
import {chatMessagesService} from "@/features/chat/model/services/chatMessages.service";
import {logger} from "@/shared/logger/logger";

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
       RTK Query: history — a group is fetched the SAME way as any conversation (its id IS a
       conversation id). getChatHistory maps a 404 (a conversation with no message backing yet) to an
       empty list, so it never leaves RTK's `data` holding the PREVIOUS chat's rows.
    ====================== */
    // Use `currentData` (per-arg), NOT `data`: RTK Query's `data` RETAINS the previous chat's rows while
    // the new chat's history is fetching — which rendered the OLD conversation's messages under the NEW
    // header on a slow switch. `currentData` is undefined until THIS chat resolves, so we show a loader
    // instead of stale rows. `isFetching` + no current data = "loading the selected chat".
    const {currentData, isFetching, isError, error} = chatApi.useGetChatHistoryQuery(
        selectedChatId ? {myId, chatId: selectedChatId} : skipToken
    );
    const loadingHistory = !!selectedChatId && isFetching && currentData === undefined;

    // Surface, don't swallow: a server error loading history used to fall back to an empty list,
    // indistinguishable from a genuinely empty chat and with no log. Log it and expose isError so
    // the UI can show a retryable error state instead of a silent "empty" window.
    useEffect(() => {
        if (isError) logger.error("getChatHistory failed", {chatId: selectedChatId, error});
    }, [isError, error, selectedChatId]);

    const [deleteHistory] = chatApi.useDeleteChatHistoryMutation();

    /* ======================
       Reload (force refetch)
    ====================== */
    const reloadChatHistory = useCallback(
        async () => {
            chatMessagesService.reloadChatHistory(dispatch, myId, selectedChatId);
        },
        [dispatch, myId, selectedChatId]
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
            [...(currentData ?? [])]
                .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
                .map((msg) => toChatMessageView(msg, myId)),
        [currentData, myId]
    );

    return {
        messages,
        loadingHistory,
        isError,
        reloadChatHistory,
        clearChat,
    };
}
