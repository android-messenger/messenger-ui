import {useCallback, useMemo} from "react";
import {useDispatch, useSelector} from "react-redux";
import type {RootState} from "@/store/store";
import {markChatRead, markChatUnread} from "@/features/chat/model/slices/chatUiSlice.ts";

/**
 * Unread state now lives in the chatUi slice (keyed by conversationId), set from chatMiddleware
 * when a CHAT_OUT arrives for a chat the user isn't viewing. This hook exposes it as a Set for the
 * chat list and the read/unread dispatchers. Unlike the old component-local useState, it survives
 * re-renders and navigation.
 */
export function useUnreadChats() {
    const dispatch = useDispatch();
    const unreadByChat = useSelector((s: RootState) => s.chatUi.unreadByChat);

    const unreadChats = useMemo(
        () => new Set(Object.keys(unreadByChat).filter((id) => unreadByChat[id])),
        [unreadByChat]
    );

    const markUnread = useCallback((chatId: string) => dispatch(markChatUnread(chatId)), [dispatch]);
    const markRead = useCallback((chatId: string) => dispatch(markChatRead(chatId)), [dispatch]);

    return {unreadChats, markUnread, markRead};
}
