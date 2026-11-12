import {createSlice, type PayloadAction} from "@reduxjs/toolkit";
import {E2EE_LS} from "@/features/e2ee/lib/stores.ts";

// Which conversations are in E2EE "secret" mode. A chat becomes secret when the user turns the mode on
// or when the first encrypted message arrives in it (chatMiddleware), and it never goes back to normal:
// there is no agreed way to turn the mode off that the server could not forge. Persisted to localStorage;
// if that is lost, the mark comes back from the encrypted messages in the history.

const KEY = E2EE_LS.secretChats;

export function loadSecretChats(): Record<string, true> {
    try {
        const raw = localStorage.getItem(KEY);
        return raw ? (JSON.parse(raw) as Record<string, true>) : {};
    } catch { return {}; }
}
export function saveSecretChats(byId: Record<string, true>): void {
    // An empty set leaves no key behind: after a logout nothing of the feature stays in localStorage.
    try {
        if (Object.keys(byId).length === 0) localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, JSON.stringify(byId));
    } catch { /* quota / unavailable */ }
}

interface SecretState { byId: Record<string, true> }
const initialState: SecretState = {byId: loadSecretChats()};

const secretChatsSlice = createSlice({
    name: "secretChats",
    initialState,
    reducers: {
        /** Marks the chat secret. One-way: nothing here removes the mark. */
        markSecret(state, action: PayloadAction<string>) {
            if (action.payload) state.byId[action.payload] = true;
        },
        clearSecretChats(state) { state.byId = {}; },
    },
});

export const {markSecret, clearSecretChats} = secretChatsSlice.actions;
export default secretChatsSlice.reducer;
