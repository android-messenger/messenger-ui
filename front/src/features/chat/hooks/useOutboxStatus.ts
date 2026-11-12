import {useCallback, useMemo} from "react";
import {useDispatch, useSelector} from "react-redux";

import type {AppDispatch, RootState} from "@/store/store";
import {chatApi} from "@/features/chat/rest/chatApi.ts";
import {retryMessage as retryOutboxMessage, discardMessage as discardOutboxMessage} from "@/features/chat/model/slices/outboxSlice.ts";
import {flushOutbox} from "@/features/chat/thunk/sendOutboxThunk.ts";
import type {ChatMessageStatus} from "@/features/chat/model/types.ts";

/**
 * Outbox delivery status for the composer/bubbles (🕐 / ⚠ + retry/discard), extracted from useChat.
 * Projects the outbox slice into an id→status map, and exposes retry (re-queue + flush) and discard
 * (drop from the outbox AND splice the optimistic row out of the open history, since it was never
 * accepted by the server).
 */
export function useOutboxStatus(params: {selectedChatId: string | null; myId: string}) {
    const {selectedChatId, myId} = params;
    const dispatch = useDispatch<AppDispatch>();

    const outboxMessages = useSelector((state: RootState) => state.outbox.messages);
    const outboxStatusById = useMemo(() => {
        const map: Record<string, ChatMessageStatus> = {};
        for (const m of outboxMessages) map[m.id] = m.status;
        return map;
    }, [outboxMessages]);

    const retryMessage = useCallback((id: string) => {
        dispatch(retryOutboxMessage(id));
        dispatch(flushOutbox());
    }, [dispatch]);

    const discardMessage = useCallback((id: string) => {
        dispatch(discardOutboxMessage(id));
        // Also drop the optimistic row from the open history (it was never accepted by the server).
        if (selectedChatId) {
            dispatch(chatApi.util.updateQueryData("getChatHistory", {myId, chatId: selectedChatId}, (draft) => {
                const i = draft.findIndex((m) => m.id === id);
                if (i >= 0) draft.splice(i, 1);
            }));
        }
    }, [dispatch, myId, selectedChatId]);

    return {outboxStatusById, retryMessage, discardMessage};
}
