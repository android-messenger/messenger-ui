import {createSlice, type PayloadAction} from "@reduxjs/toolkit";
import {E2EE_LS} from "@/features/e2ee/wire.ts";
import {kvSet, KV} from "@/features/chat/db/db.ts";
import {sealing} from "@/features/chat/db/sealed.ts";

// Which conversations are in E2EE "secret" mode. The user turns the mode on and off at will (owner's
// decision 2026-11-12); a chat also becomes secret when an encrypted message arrives in it
// (chatMiddleware), so the reply goes encrypted. The mode is turned OFF only by the user's own tap:
// nothing that comes from the server — a plaintext message included — switches a chat to normal.
//
// true — secret; false — the user turned it off (remembered, so the encrypted messages in the history do
// not turn it back on); absent — never set. Persisted to localStorage; if that is lost, the mark comes
// back from the encrypted messages in the history. In the Android app the list is a sealed record
// instead (KV.secretChats), restored at startup by hydrateSecretChats.

const KEY = E2EE_LS.secretChats;

export type SecretChats = Record<string, boolean>;

export function loadSecretChats(): SecretChats {
    if (sealing()) return {};
    try {
        const raw = localStorage.getItem(KEY);
        return raw ? (JSON.parse(raw) as SecretChats) : {};
    } catch { return {}; }
}
export function saveSecretChats(byId: SecretChats): void {
    if (sealing()) { void kvSet(KV.secretChats, byId).catch(() => { /* best-effort */ }); return; }
    // An empty set leaves no key behind: after a logout nothing of the feature stays in localStorage.
    try {
        if (Object.keys(byId).length === 0) localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, JSON.stringify(byId));
    } catch { /* quota / unavailable */ }
}

interface SecretState { byId: SecretChats }
const initialState: SecretState = {byId: loadSecretChats()};

const secretChatsSlice = createSlice({
    name: "secretChats",
    initialState,
    reducers: {
        /** The chat is secret from now on: what is sent in it is encrypted. */
        markSecret(state, action: PayloadAction<string>) {
            if (action.payload) state.byId[action.payload] = true;
        },
        /** The user turned the secret mode off. Dispatched only from the chat header — never on a server frame. */
        unmarkSecret(state, action: PayloadAction<string>) {
            if (action.payload) state.byId[action.payload] = false;
        },
        clearSecretChats(state) { state.byId = {}; },
        /** Android app, startup: the list read from the sealed record. What changed meanwhile wins. */
        hydrateSecretChats(state, action: PayloadAction<SecretChats | null>) {
            state.byId = {...(action.payload ?? {}), ...state.byId};
        },
    },
});

export const {markSecret, unmarkSecret, clearSecretChats, hydrateSecretChats} = secretChatsSlice.actions;
export default secretChatsSlice.reducer;
