import {createSlice, type PayloadAction} from "@reduxjs/toolkit";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema";
import {sameMessage, upsertMessage} from "@/features/chat/model/historyCache";
import {mergeHistory} from "@/features/chat/model/mergeHistory";

// Spec 003, story 2 — the messages of the chats, in a slice of their own.
//
// Before this the messages lived in the cache of a request (RTK Query): a chat nobody was subscribed to
// had no place to put a message from the socket, and every answer of the history replaced the whole
// chat. Here a chat holds its rows as long as the user is signed in; the socket writes to it whether it
// is on the screen or not, and an answer of the history is merged in (mergeHistory), never put instead.
//
// The slice also holds the sign that the socket had a gap (spec 002 §3.1, formerly historySync.ts): a
// chat counts as complete only while its history was read from the server under the CURRENT connection
// of the socket, by a request that started when the socket was already connected. Any gap gives a new
// connection number, so every chat is stale at once.

export interface ChatHistory {
    /** The rows of the chat, oldest first. Absent until the first answer (or my first message) is in. */
    rows?: ChatMessage[];
    /** Rows that came over the socket while the chat was read for the first time: merged with the answer. */
    held: ChatMessage[];
    /** How many reads of the history are on their way. */
    reading: number;
    /** Ids of the rows that came over the socket (or were confirmed) while a read was on its way. */
    arrived: string[];
    /** The connection of the socket under which the history was last read in full; null — stale. */
    readEpoch: number | null;
    /** The last read has failed. */
    error: boolean;
    /** The rows came from the disk and no answer of the server has been merged yet. */
    fromDisk: boolean;
    /** The server has nothing older than the first row. */
    noOlder: boolean;
}

export interface ChatHistoryState {
    byChat: Record<string, ChatHistory>;
}

const initialState: ChatHistoryState = {byChat: {}};

const empty = (): ChatHistory => ({held: [], reading: 0, arrived: [], readEpoch: null, error: false, fromDisk: false, noOlder: false});

function chatOf(state: ChatHistoryState, chatId: string): ChatHistory {
    return state.byChat[chatId] ?? (state.byChat[chatId] = empty());
}

/** Which row: by the id of the row, or by the id the sender gave the message. */
export interface RowRef {
    chatId: string;
    id?: string;
    clientId?: string;
}

function indexOfRow(rows: ChatMessage[] | undefined, ref: RowRef): number {
    if (!rows) return -1;
    return rows.findIndex((m) =>
        (!!ref.id && m.id === ref.id) ||
        (!!ref.clientId && (m.clientId === ref.clientId || m.id === ref.clientId)));
}

const chatHistorySlice = createSlice({
    name: "chatHistory",
    initialState,
    reducers: {
        /** A read of the chat's history has been sent to the server. */
        readStarted(state, action: PayloadAction<{chatId: string}>) {
            const chat = chatOf(state, action.payload.chatId);
            if (chat.reading === 0) chat.arrived = [];
            chat.reading++;
        },

        /**
         * The server has answered. `answer` — its page, oldest first; `whole` — the page is the chat's whole
         * history; `epoch` — the connection the read proves the chat complete under (null — it proves
         * nothing: the socket was down or changed meanwhile); `queued` — my messages still in the send queue.
         */
        answerTaken(state, action: PayloadAction<{chatId: string; answer: ChatMessage[]; whole: boolean; epoch: number | null; queued?: ChatMessage[]}>) {
            const {chatId, answer, whole, epoch, queued = []} = action.payload;
            const chat = chatOf(state, chatId);
            const current = [...(chat.rows ?? [])];
            for (const m of chat.held) upsertMessage(current, m);
            for (const m of queued) upsertMessage(current, m);
            const keep = new Set<string>(chat.arrived);
            for (const m of chat.held) keep.add(m.id);
            // a queued message is kept under whatever id its row has by now
            for (const q of queued) for (const m of current) if (sameMessage(m, q)) keep.add(m.id);
            chat.rows = mergeHistory({current, answer, whole, arrived: keep});
            chat.held = [];
            chat.reading = Math.max(0, chat.reading - 1);
            if (chat.reading === 0) chat.arrived = [];
            chat.error = false;
            chat.fromDisk = false;
            if (whole) chat.noOlder = true;
            if (epoch !== null) chat.readEpoch = epoch;
        },

        /** The read has failed: the chat keeps what it has. */
        readFailed(state, action: PayloadAction<{chatId: string}>) {
            const chat = chatOf(state, action.payload.chatId);
            chat.reading = Math.max(0, chat.reading - 1);
            if (chat.reading === 0) chat.arrived = [];
            chat.error = true;
        },

        /**
         * A message has come over the socket. Written if the chat is in the slice or is being read; a chat
         * that was never opened takes it from the server when it is opened.
         */
        socketRow(state, action: PayloadAction<{chatId: string; row: ChatMessage}>) {
            const {chatId, row} = action.payload;
            const chat = state.byChat[chatId];
            if (!chat) return;
            if (chat.rows) upsertMessage(chat.rows, row);
            else if (chat.reading > 0) upsertMessage(chat.held, row);
            else return;
            if (chat.reading > 0) chat.arrived.push(row.id);
        },

        /** A page older than the first row. `noOlder` — the server has nothing before it. */
        olderTaken(state, action: PayloadAction<{chatId: string; rows: ChatMessage[]; noOlder: boolean}>) {
            const chat = state.byChat[action.payload.chatId];
            if (!chat?.rows) return;
            const fresh = action.payload.rows.filter((m) => !chat.rows!.some((r) => sameMessage(r, m)));
            if (fresh.length) chat.rows.unshift(...fresh);
            if (action.payload.noOlder) chat.noOlder = true;
        },

        /** The rows stored on the device: shown until the server answers. Never over what is already there. */
        diskTaken(state, action: PayloadAction<{chatId: string; rows: ChatMessage[]}>) {
            const chat = chatOf(state, action.payload.chatId);
            if (chat.rows) return;
            chat.rows = [...action.payload.rows];
            chat.fromDisk = true;
        },

        /** My own message, shown at once. Until story 2б (T316) only in a chat whose rows are in. */
        echoPut(state, action: PayloadAction<{chatId: string; row: ChatMessage}>) {
            const chat = state.byChat[action.payload.chatId];
            if (!chat?.rows) return;
            upsertMessage(chat.rows, action.payload.row);
        },

        /** The server took my message: its row gets the server's id and time. */
        ackTaken(state, action: PayloadAction<{chatId: string; clientId: string; serverId?: string; at?: number}>) {
            const {chatId, clientId, serverId, at} = action.payload;
            const chat = state.byChat[chatId];
            const i = indexOfRow(chat?.rows, {chatId, clientId});
            if (!chat || i < 0) return;
            const row = chat.rows![i];
            if (serverId) row.id = serverId;
            if (typeof at === "number") row.createdAt = new Date(at);
            // a read on its way may have left the server before the message was stored
            if (chat.reading > 0) chat.arrived.push(row.id);
        },

        /** Change fields of one row (the decrypted text, "not stored on this device"). */
        rowFixed(state, action: PayloadAction<RowRef & {fix: Partial<Pick<ChatMessage, "text" | "secret" | "unsaved">>}>) {
            const chat = state.byChat[action.payload.chatId];
            const fix = action.payload.fix;
            for (const rows of [chat?.rows, chat?.held]) {
                const i = indexOfRow(rows, action.payload);
                if (i >= 0) Object.assign(rows![i], fix);
            }
        },

        /** Take one row out (deleted, or a message that was given up). */
        rowRemoved(state, action: PayloadAction<RowRef>) {
            const chat = state.byChat[action.payload.chatId];
            const i = indexOfRow(chat?.rows, action.payload);
            if (i >= 0) chat!.rows!.splice(i, 1);
        },

        /** Put a row back (the server refused to delete it). */
        rowRestored(state, action: PayloadAction<{chatId: string; row: ChatMessage}>) {
            const chat = state.byChat[action.payload.chatId];
            if (!chat?.rows) return;
            upsertMessage(chat.rows, action.payload.row);
            chat.rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        },

        /** The chat was cleared: no rows, nothing older. */
        chatCleared(state, action: PayloadAction<{chatId: string}>) {
            const chat = state.byChat[action.payload.chatId];
            if (!chat) return;
            chat.rows = [];
            chat.held = [];
            chat.noOlder = true;
        },

        /** The chat got something outside the socket (a push, a notification tap): it must be read again. */
        historyStale(state, action: PayloadAction<{chatId: string}>) {
            const chat = state.byChat[action.payload.chatId];
            if (chat) chat.readEpoch = null;
        },

        /** Sign-out, another account: nothing of the chats stays in memory. */
        historyForgotten() {
            return initialState;
        },
    },
});

export const {
    readStarted, answerTaken, readFailed, socketRow, olderTaken, diskTaken, echoPut, ackTaken,
    rowFixed, rowRemoved, rowRestored, chatCleared, historyStale, historyForgotten,
} = chatHistorySlice.actions;
export default chatHistorySlice.reducer;

// ---- reading the slice ---------------------------------------------------------------------------

type WithHistory = {chatHistory: ChatHistoryState};
type WsView = {status?: string; epoch?: number} | undefined;

/** The rows of the chat; undefined — nothing is known about it yet. */
export function selectRows(state: WithHistory, chatId: string | null | undefined): ChatMessage[] | undefined {
    return chatId ? state.chatHistory.byChat[chatId]?.rows : undefined;
}

export function selectChatHistory(state: WithHistory, chatId: string | null | undefined): ChatHistory | undefined {
    return chatId ? state.chatHistory.byChat[chatId] : undefined;
}

/** The connection number if the socket is connected now, else null (nothing read now can be proved complete). */
export function liveEpoch(ws: WsView): number | null {
    return ws?.status === "connected" && typeof ws.epoch === "number" ? ws.epoch : null;
}

/** True if the chat's history cannot be proved complete: read under another connection, or never. */
export function isStale(state: WithHistory & {ws?: WsView}, chatId: string): boolean {
    const now = liveEpoch(state.ws);
    return now === null || (state.chatHistory.byChat[chatId]?.readEpoch ?? null) !== now;
}
