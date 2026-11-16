import {useCallback, useEffect, useRef} from "react";
import {useDispatch, useSelector, useStore} from "react-redux";

import type {AppDispatch, RootState} from "@/store/store";
import {chatMessagesService} from "@/features/chat/model/services/chatMessages.service.ts";
import {flushOutbox} from "@/features/chat/thunk/sendOutboxThunk.ts";
import {logger} from "@/shared/logger/logger.ts";
import {isStale, selectChatHistory} from "@/features/chat/model/slices/chatHistorySlice.ts";
import {pageHidden} from "@/features/chat/model/onScreen.ts";
import {unreadAsked} from "@/features/chat/model/slices/deliverySlice.ts";

/** A failed read of the open chat is tried again after 2, 4, 8, … s, at most a minute apart (FR-040). */
export const REREAD_FIRST_MS = 2_000;
export const REREAD_MAX_MS = 60_000;

/**
 * The catch-up after a gap, so nothing that arrived while we were away is missed. Runs once for the
 * whole application (useDelivery).
 *
 *  1. A new connection of the socket: the send queue goes out, the chat list and the "unread" marks
 *     are asked — once per connection — and the open chat is read, because it is stale.
 *  2. A read of the open chat that failed is tried again with a growing pause while the socket is
 *     connected and the chat is open (FR-040).
 *  3. Back on the screen or back on the network with a socket that says it is connected: the list and
 *     the open chat are read over REST — a backgrounded page can come back with a socket that reports
 *     OPEN but is dead. With the socket closed nothing is asked: its connection does step 1 (FR-046).
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

    // Spec 002 §3.2: after every connection of the socket (= after every gap, and at the start) the
    // "unread" marks are taken from the server: fresh chat list first (my read positions), then the
    // newest message of each chat.
    // Once per connection: a re-mount of the page under the same connection asks nothing.
    useEffect(() => {
        // The connection the marks were last asked under is in the store (deliverySlice): a new session
        // asks again.
        if (wsStatus !== "connected" || store.getState().delivery.unreadAskedUnder === wsEpoch) return;
        dispatch(unreadAsked(wsEpoch));
        void (async () => {
            await chatMessagesService.refetchChatsPreservingSelected(dispatch, store.getState);
            if (store.getState().ws.epoch === wsEpoch) await chatMessagesService.probeUnread(dispatch, store.getState);
        })();
    }, [wsStatus, wsEpoch, dispatch, store]);

    // Read-through ONLY on the actual disconnected→connected transition — NOT on every chat switch.
    const prevWsRef = useRef(wsStatus);
    useEffect(() => {
        const was = prevWsRef.current;
        prevWsRef.current = wsStatus;
        if (wsStatus !== "connected" || was === "connected") return;
        dispatch(flushOutbox());                 // resend anything still queued (idempotent)
        // The chat list is refreshed by the unread check above.
        // The open chat's history is read by the stale check below.
    }, [wsStatus, dispatch]);

    // Spec 002 §3.1: the chat on screen must be provably complete. It is read again whenever it is stale —
    // opened after a gap (also by a notification tap, which comes before the socket is back), or the
    // socket has just connected again. A chat read under the current connection is left alone.
    useEffect(() => {
        if (!selectedChatId || wsStatus !== "connected") return;
        if (!isStale(store.getState(), selectedChatId)) return;
        // A read on its way reads the chat once more by itself if the socket changed under it (readHistory).
        if ((selectChatHistory(store.getState(), selectedChatId)?.reading ?? 0) > 0) return;
        logger.info("sync: chat is stale, reading its history", {chatId: selectedChatId, epoch: wsEpoch});
        Promise.resolve(reloadChatHistory()).catch(() => {});
    }, [selectedChatId, wsStatus, wsEpoch, reloadChatHistory, store]);

    // FR-040: the read of the open chat has failed — it is tried again after 2, 4, 8, … 60 s, while the
    // socket is connected and the chat is open. A new connection and another chat start from 2 s.
    const read = useSelector((state: RootState) => {
        const chat = selectChatHistory(state, selectedChatId);
        return !chat || chat.reading > 0 ? "reading" : chat.error ? "failed" : "done";
    });
    const failures = useRef(0);
    useEffect(() => { failures.current = 0; }, [selectedChatId, wsEpoch]);
    useEffect(() => {
        if (read === "done") failures.current = 0;
        if (!selectedChatId || wsStatus !== "connected" || read !== "failed") return;
        // The effect above may have just started a read of this chat: then there is nothing to try again yet.
        if ((selectChatHistory(store.getState(), selectedChatId)?.reading ?? 0) > 0) return;
        const pause = Math.min(REREAD_FIRST_MS * 2 ** failures.current, REREAD_MAX_MS);
        failures.current++;
        logger.info("sync: history read failed, reading again", {chatId: selectedChatId, inMs: pause});
        const timer = setTimeout(() => { Promise.resolve(reloadChatHistory()).catch(() => {}); }, pause);
        return () => clearTimeout(timer);
    }, [read, selectedChatId, wsStatus, wsEpoch, reloadChatHistory, store]);

    // Catch up over REST on RESUME from background / network recovery, when the socket says it is
    // connected. A closed socket is being connected (useWebSocketConnection): the list and the chat are
    // read once, under the new connection, by the effects above.
    useEffect(() => {
        const onResume = () => {
            if (pageHidden()) return;
            if (store.getState().ws.status !== "connected") return;
            catchUpChats();
            if (selectedChatId) Promise.resolve(reloadChatHistory()).catch(() => {});
        };
        document.addEventListener("visibilitychange", onResume);
        window.addEventListener("online", onResume);
        return () => {
            document.removeEventListener("visibilitychange", onResume);
            window.removeEventListener("online", onResume);
        };
    }, [selectedChatId, reloadChatHistory, catchUpChats, store]);
}
