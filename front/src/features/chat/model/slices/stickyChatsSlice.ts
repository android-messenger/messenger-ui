import {createSlice, type PayloadAction} from "@reduxjs/toolkit";
import type {ChatSummary} from "@/entities/conversation";
import {clearUser} from "@/features/auth";

// "Sticky" chats: DIRECT conversations the user has engaged with (opened/created) stay in their list
// even when EMPTY. The backend hides message-less conversations from GET /api/chats (by design), so a
// chat you created but never messaged — or whose messages you later deleted one by one — silently
// disappears. We remember it locally and merge it back into the list (see useContacts); it's dropped
// only when the user explicitly deletes the chat (the ✕). Groups are never stickied — they come from
// GET /api/groups regardless of activity. Persisted to localStorage; cleared on logout.

const KEY = "wolp.sticky-chats.v1";
const MAX = 300;

export function loadStickyChats(): Record<string, ChatSummary> {
    try {
        const raw = localStorage.getItem(KEY);
        const obj = raw ? JSON.parse(raw) : null;
        return obj && typeof obj === "object" ? obj : {};
    } catch {
        return {};
    }
}

export function saveStickyChats(byId: Record<string, ChatSummary>): void {
    try { localStorage.setItem(KEY, JSON.stringify(byId)); } catch { /* quota / unavailable */ }
}

interface StickyState {
    byId: Record<string, ChatSummary>;
}

const initialState: StickyState = {byId: loadStickyChats()};

const stickyChatsSlice = createSlice({
    name: "stickyChats",
    initialState,
    reducers: {
        rememberSticky(state, action: PayloadAction<ChatSummary | null | undefined>) {
            const s = action.payload;
            if (!s || s.kind === "group" || !s.conversationId) return;
            state.byId[s.conversationId] = s;
            const ids = Object.keys(state.byId);
            if (ids.length > MAX) delete state.byId[ids[0]]; // bound the set (drop the oldest)
        },
        forgetSticky(state, action: PayloadAction<string>) {
            delete state.byId[action.payload];
        },
    },
    extraReducers: (builder) => {
        builder.addCase(clearUser, (state) => { state.byId = {}; });
    },
});

export const {rememberSticky, forgetSticky} = stickyChatsSlice.actions;
export default stickyChatsSlice.reducer;
