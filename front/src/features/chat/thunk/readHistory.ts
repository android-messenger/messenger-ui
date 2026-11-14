import type {AppDispatch, RootState} from "@/store/store";
import {chatApi} from "@/features/chat/rest/chatApi";
import {HISTORY_PAGE_SIZE} from "@/shared/config/chat";
import {toMessages, dedupMessages} from "@/features/chat/model/reconcileHistory";
import {answerTaken, liveEpoch, readFailed, readStarted, selectRows} from "@/features/chat/model/slices/chatHistorySlice";
import {setPeerLastReadId} from "@/features/chat/model/slices/chatUiSlice";
import {saveHistoryToDB} from "@/features/chat/db/db";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema";
import {logger} from "@/shared/logger/logger";

/**
 * My messages of this chat that are still in the send queue, as rows. The server's rows carry no client
 * id, so a queued message whose ACK was lost cannot be matched to its own server row by id: a queued
 * message with the same text and kind as one of my rows in the answer is taken as delivered and left out.
 */
function queuedRows(state: RootState, chatId: string, myId: string, answer: ChatMessage[]): ChatMessage[] {
    const mine = new Set(answer.filter((m) => m.from === myId).map((m) => `${m.kind ?? ""}\0${m.text}`));
    const rows: ChatMessage[] = [];
    for (const o of state.outbox?.messages ?? []) {
        const p = o.payload;
        if (p?.conversationId !== chatId) continue;
        if (mine.has(`${p.payload?.kind ?? ""}\0${p.payload?.body ?? ""}`)) continue;
        rows.push({
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
    return rows;
}

/**
 * Reads the newest page of the chat's history from the server and merges it into the chat (spec 003,
 * FR-011, FR-013). Resolves to true if the server answered.
 *
 * The answer is merged, not put instead of the chat: what came over the socket after the request was
 * sent, my unsent messages and the older pages stay (model/mergeHistory.ts).
 *
 * The read proves the chat complete only if it started and ended under one connection of the socket
 * (spec 002 §3.1). If it does not and the socket is up now, the chat is read once more.
 */
export function readHistory(chatId: string) {
    return async (dispatch: AppDispatch, getState: () => RootState): Promise<boolean> => {
        const myId = (getState().user?.id as string) || "";
        if (!chatId) return false;
        const startedUnder = liveEpoch(getState().ws);
        dispatch(readStarted({chatId}));

        const res = await dispatch(chatApi.endpoints.getHistoryPage.initiate({chatId}, {forceRefetch: true, subscribe: false}));
        // A 404 = a conversation with no message backing yet (e.g. a group whose history endpoint isn't
        // wired): an EMPTY chat, not an error.
        const status = (res.error as {status?: unknown} | undefined)?.status;
        if (res.error && status !== 404) {
            logger.info("sync: history read failed", {chatId, status});
            dispatch(readFailed({chatId}));
            return false;
        }
        const raw = res.error ? undefined : res.data;
        const answer = dedupMessages(toMessages(raw));

        const now = liveEpoch(getState().ws);
        const proved = startedUnder !== null && now === startedUnder;
        logger.info("sync: history read", {chatId, rows: answer.length, complete: proved});

        // ✓✓ source of truth (backend contract): the response is an envelope { messages, peerLastReadId }
        // where peerLastReadId is the peer's read watermark (a server ULID, or null/legacy). ULID-guarded
        // and monotonic in the reducer, so a null or legacy watermark is simply ignored.
        const peerLastReadId = (raw as {peerLastReadId?: string | null} | undefined)?.peerLastReadId;
        if (peerLastReadId) dispatch(setPeerLastReadId({chatId, lastReadId: peerLastReadId}));

        dispatch(answerTaken({
            chatId,
            answer,
            whole: answer.length < HISTORY_PAGE_SIZE,
            epoch: proved ? startedUnder : null,
            queued: queuedRows(getState(), chatId, myId, answer),
        }));

        // The device's copy of the chat (secret rows are dropped inside saveHistoryToDB).
        const rows = selectRows(getState(), chatId);
        if (rows) saveHistoryToDB(chatId, rows).catch(() => { /* best-effort */ });

        // Read while the socket was down or changing, and it is up now: the answer may miss what came in
        // between. Read once more under the live connection.
        if (!proved && now !== null) {
            setTimeout(() => { void dispatch(readHistory(chatId)); }, 0);
        }
        return true;
    };
}

/** The chat leaves the screen: its rows go to the disk as they are now. */
export function storeHistory(chatId: string) {
    return async (_dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
        const rows = selectRows(getState(), chatId);
        if (rows) await saveHistoryToDB(chatId, rows).catch(() => { /* best-effort */ });
    };
}
