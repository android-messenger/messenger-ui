import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import {logger} from "@/shared/logger/logger.ts";
import {isUlid} from "@/shared/ulid/ulid.ts";
import {clearUser} from "@/features/auth";

interface ChatUiState {
    selectedChatId: string | null;
    // Per-conversation read boundary: the messageId (server ULID) up to which the PEER has read my
    // messages. Server-driven — comes from the history response (`HistoryPage.peerLastReadId`) and
    // from the live READ_OUT frame (its correlationId). A sent message shows ✓✓ iff
    // `messageId <= peerLastReadId` (ULID lexicographic == chronological). Monotonic.
    peerLastReadIdByChat: Record<string, string>;
    // Per-conversation: is the peer currently typing (set on TYPING_OUT, auto-cleared).
    typingByChat: Record<string, boolean>;
    // Per-conversation: id of the last author seen typing (for GROUP headers → "<name> is typing").
    // Set alongside typingByChat when TYPING_OUT carries a senderId; cleared with it. 1:1 ignores it.
    typingUserByChat: Record<string, string>;
    // Per-conversation: has unread incoming message(s). Lives in the store (not component state)
    // so it survives re-renders/navigation and can be set from chatMiddleware.
    unreadByChat: Record<string, boolean>;
}

const initialState: ChatUiState = {
    selectedChatId: null,
    peerLastReadIdByChat: {},
    typingByChat: {},
    typingUserByChat: {},
    unreadByChat: {},
};

const chatUiSlice = createSlice({
    name: "chatUi",
    initialState,
    reducers: {
        setSelectedChatId(state, action: PayloadAction<string | null>) {
            logger.debug("setSelectedChatId", action.payload);
            state.selectedChatId = action.payload;
        },
        // Advance the peer's read boundary (a message ULID) for a conversation. Monotonic: ULIDs sort
        // lexicographically by time, so we keep the greater id and never regress (ignores empty/null).
        //
        // The boundary MUST be a server ULID — that is the only thing comparable to a message id. A
        // non-ULID boundary (e.g. the backend's synthetic "read-<conv>-<reader>" READ_OUT marker, whose
        // lowercase 'r' sorts ABOVE every ULID) would make `msg.id <= boundary` true for EVERY message
        // and light up ✓✓ instantly — even for a just-sent message to an offline peer. Reject anything
        // that isn't a ULID so garbage can never poison the read state.
        setPeerLastReadId(state, action: PayloadAction<{ chatId: string; lastReadId?: string | null }>) {
            const next = action.payload.lastReadId;
            if (!isUlid(next)) {
                if (next) logger.warn("ignoring non-ULID read boundary", {chatId: action.payload.chatId, lastReadId: next});
                return;
            }
            const cur = state.peerLastReadIdByChat[action.payload.chatId];
            if (!cur || next > cur) state.peerLastReadIdByChat[action.payload.chatId] = next;
        },
        setTyping(state, action: PayloadAction<{ chatId: string; typing: boolean; author?: string }>) {
            const {chatId, typing, author} = action.payload;
            state.typingByChat[chatId] = typing;
            if (typing && author) state.typingUserByChat[chatId] = author;
            else if (!typing) delete state.typingUserByChat[chatId];
        },
        markChatUnread(state, action: PayloadAction<string>) {
            state.unreadByChat[action.payload] = true;
        },
        markChatRead(state, action: PayloadAction<string>) {
            delete state.unreadByChat[action.payload];
        },
    },
    extraReducers: (builder) => {
        // Drop all per-conversation UI state on logout so a new session starts clean.
        builder.addCase(clearUser, (state) => {
            state.selectedChatId = null;
            state.peerLastReadIdByChat = {};
            state.typingByChat = {};
            state.typingUserByChat = {};
            state.unreadByChat = {};
        });
    },
});

export const { setSelectedChatId, setPeerLastReadId, setTyping, markChatUnread, markChatRead } =
    chatUiSlice.actions;
export default chatUiSlice.reducer;
