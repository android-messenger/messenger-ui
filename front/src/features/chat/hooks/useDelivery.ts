import {useCallback} from "react";
import {useDispatch, useSelector} from "react-redux";
import type {AppDispatch, RootState} from "@/store/store";
import {readHistory} from "@/features/chat/thunk/readHistory.ts";
import {useOutboxRetry} from "./useOutboxRetry.ts";
import {useReconnectCatchup} from "./useReconnectCatchup.ts";

/**
 * Delivery, once for the whole application (spec 003, FR-044): the send queue is looked at on a timer,
 * and after every connection of the socket the queue goes out, the chat list and the "unread" marks are
 * asked and the open chat is read again. Mounted where the socket lives (app/App.tsx), so it works on
 * every page the socket works on, not only on the main one.
 */
export function useDelivery(): void {
    const dispatch = useDispatch<AppDispatch>();
    const selectedChatId = useSelector((state: RootState) => state.chatUi.selectedChatId);
    const reloadChatHistory = useCallback(
        () => (selectedChatId ? dispatch(readHistory(selectedChatId)) : undefined),
        [dispatch, selectedChatId],
    );
    useOutboxRetry();
    useReconnectCatchup({selectedChatId, reloadChatHistory});
}
