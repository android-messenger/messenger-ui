import {useCallback, useEffect} from "react";
import {useDispatch, useSelector, useStore} from "react-redux";

import type {AppDispatch, RootState} from "@/store/store";
import {chatApi} from "@/features/chat/rest/chatApi.ts";
import {buildReadIn} from "@/features/chat/model/schema/wireMessage.schema.ts";
import {isUlid} from "@/shared/ulid/ulid.ts";

/**
 * Read-receipt (READ_IN) machinery, extracted from the useChat god-hook. Owns the single source of
 * the read boundary (the newest rendered SERVER ULID) and the three triggers that (re)send READ_IN
 * for the open+visible chat: tab becomes visible, the socket (re)connects, and a new message
 * arrives. `sendReadReceipt` is also handed back so `openChat` can mark-read on open.
 *
 * Behavior is preserved verbatim from useChat, including the ONE deliberate asymmetry:
 *  - visible/open (onVisible) and openChat send a READ_IN even when the boundary is still unknown
 *    (empty correlationId) — the peer receives a READ_OUT and the boundary catches up on the next
 *    trigger;
 *  - the connect and newest-message triggers require a known boundary (`requireBoundary`) so they
 *    don't emit a boundary-less frame on every reconnect / cache tick.
 */
export function useReadReceipts(params: {
    selectedChatId: string | null;
    newestMessageId: string | null;
    getSummary: (chatId: string) => {counterpartId: string; kind?: string} | null | undefined;
    markRead: (chatId: string) => void;
}) {
    const {selectedChatId, newestMessageId, getSummary, markRead} = params;
    const dispatch = useDispatch<AppDispatch>();
    const store = useStore<RootState>();
    const myId = useSelector((s: RootState) => s.user.id);
    const wsStatus = useSelector((s: RootState) => s.ws.status);

    // Newest id in a chat that is a real server ULID (skips our own not-yet-reconciled temp client
    // ids). READ_IN carries this as the read boundary the peer stores + uses for ✓✓.
    const lastReadMessageId = useCallback((chatId: string): string | undefined => {
        const data = chatApi.endpoints.getChatHistory.select({myId, chatId})(store.getState())?.data;
        if (!data) return undefined;
        for (let i = data.length - 1; i >= 0; i--) {
            if (isUlid(data[i].id)) return data[i].id;
        }
        return undefined;
    }, [myId, store]);

    // Send a READ_IN for chatId carrying the newest rendered server ULID as the read boundary.
    // requireBoundary: skip when the boundary is unknown (used by the connect / newest triggers).
    const sendReadReceipt = useCallback((chatId: string, opts?: {requireBoundary?: boolean}) => {
        const s = getSummary(chatId);
        if (!s) return;
        // Groups have no per-member read watermark (no ✓✓ aggregate) — READ_IN would be a no-op frame.
        // Local unread clearing still happens via markRead (openChat/onVisible), independent of this.
        if (s.kind === "group") return;
        const boundary = lastReadMessageId(chatId);
        if (opts?.requireBoundary && !boundary) return;
        dispatch({type: "ws/send", payload: buildReadIn(chatId, s.counterpartId, boundary)});
    }, [lastReadMessageId, getSummary, dispatch]);

    // Deferred read: messages that arrived while the tab was hidden are marked read only when the
    // tab regains focus with the chat still open (mirrors the "active = open AND visible" rule).
    useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState !== "visible" || !selectedChatId) return;
            markRead(selectedChatId);
            sendReadReceipt(selectedChatId);
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => document.removeEventListener("visibilitychange", onVisible);
    }, [selectedChatId, markRead, sendReadReceipt]);

    // (Re)send READ_IN whenever we become CONNECTED with the open chat visible. READ_IN is
    // fire-and-forget over the WS with no retry, so one dispatched while the socket was still
    // reconnecting/suspended (the resume-from-background case) is silently dropped and the peer's ✓✓
    // never advances. Re-sending on connect delivers it. Idempotent (backend advances by GREATEST).
    useEffect(() => {
        if (wsStatus !== "connected" || !selectedChatId) return;
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
        sendReadReceipt(selectedChatId, {requireBoundary: true});
    }, [wsStatus, selectedChatId, sendReadReceipt]);

    // Report "read up to the newest message" whenever the OPEN + visible chat gains a message.
    // openChat fires a read BEFORE history is fetched (empty boundary), so we (re)send once the
    // history — and each later arrival — is present, carrying the newest server ULID. Idempotent.
    useEffect(() => {
        if (!selectedChatId) return;
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
        sendReadReceipt(selectedChatId, {requireBoundary: true});
    }, [selectedChatId, newestMessageId, sendReadReceipt]);

    return {lastReadMessageId, sendReadReceipt};
}
