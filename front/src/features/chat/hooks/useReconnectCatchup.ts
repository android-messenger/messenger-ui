import {useCallback, useEffect, useRef} from "react";
import {useDispatch, useSelector, useStore} from "react-redux";

import type {AppDispatch, RootState} from "@/store/store";
import {chatMessagesService} from "@/features/chat/model/services/chatMessages.service.ts";
import {flushOutbox} from "@/features/chat/thunk/sendOutboxThunk.ts";
import {logger} from "@/shared/logger/logger.ts";
import {isStale} from "@/features/chat/model/historySync.ts";

/**
 * Catch-up-after-a-gap logic, extracted from the useChat god-hook. Two independent triggers refresh
 * the chat list + the open chat's history so nothing that arrived while we were away is missed:
 *
 *  1. wsStatus disconnected→connected TRANSITION (not every chat switch — the transition guard stops
 *     a refetch storm on plain chat opens): resend the outbox (idempotent) + refresh list + history.
 *  2. RESUME from background / network recovery (visibilitychange→visible, `online`), independent of
 *     the WS state — a backgrounded mobile PWA can resume with a socket that reports OPEN but is dead,
 *     so the transition trigger never re-fires; without this, missed messages only show after reload.
 *
 * All getChats refreshes go through refetchChatsPreservingSelected (the single funnel that keeps a
 * freshly-created, still-hidden selected chat from vanishing).
 */
export function useReconnectCatchup(params: {
    selectedChatId: string | null;
    reloadChatHistory: () => Promise<unknown> | unknown;
}) {
    const {selectedChatId, reloadChatHistory} = params;
    const dispatch = useDispatch<AppDispatch>();
    const store = useStore<RootState>();
    const wsStatus = useSelector((state: RootState) => state.ws.status);
    const wsEpoch = useSelector((state: RootState) => state.ws.epoch);

    const catchUpChats = useCallback(() => {
        chatMessagesService.refetchChatsPreservingSelected(dispatch, store.getState);
    }, [dispatch, store]);

    // Read-through ONLY on the actual disconnected→connected transition — NOT on every chat switch.
    const prevWsRef = useRef(wsStatus);
    useEffect(() => {
        const was = prevWsRef.current;
        prevWsRef.current = wsStatus;
        if (wsStatus !== "connected" || was === "connected") return;
        dispatch(flushOutbox());                 // resend anything still queued (idempotent)
        catchUpChats();                          // refresh the chat list (new convs while offline)
        // The open chat's history is read by the stale check below.
    }, [wsStatus, catchUpChats, dispatch]);

    // Spec 002 §3.1: the chat on screen must be provably complete. It is read again whenever it is stale —
    // opened after a gap (also by a notification tap, which comes before the socket is back), or the
    // socket has just connected again. A chat read under the current connection is left alone.
    useEffect(() => {
        if (!selectedChatId || wsStatus !== "connected") return;
        if (!isStale(selectedChatId, store.getState().ws)) return;
        logger.info("sync: chat is stale, reading its history", {chatId: selectedChatId, epoch: wsEpoch});
        Promise.resolve(reloadChatHistory()).catch(() => {});
    }, [selectedChatId, wsStatus, wsEpoch, reloadChatHistory, store]);

    // Catch up over REST on RESUME from background / network recovery — independent of the WS state.
    useEffect(() => {
        const onResume = () => {
            if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
            catchUpChats();
            if (selectedChatId) Promise.resolve(reloadChatHistory()).catch(() => {});
        };
        document.addEventListener("visibilitychange", onResume);
        window.addEventListener("online", onResume);
        return () => {
            document.removeEventListener("visibilitychange", onResume);
            window.removeEventListener("online", onResume);
        };
    }, [selectedChatId, reloadChatHistory, catchUpChats]);
}
