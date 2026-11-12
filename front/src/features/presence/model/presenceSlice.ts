import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { clearUser } from "@/features/auth";

// Mirrors the backend ClientData carried in PRESENT_* frames (payload.body JSON).
export type ClientData = {
    id: string;
    name?: string;
    email?: string;
    role?: string;
};

export type PresenceEntry = ClientData & { online: boolean };

type PresenceState = { byId: Record<string, PresenceEntry> };

const initialState: PresenceState = { byId: {} };

const presenceSlice = createSlice({
    name: "presence",
    initialState,
    reducers: {
        // PRESENT_INIT — authoritative snapshot of who is online now. Mark every known peer offline
        // first so anyone missing from the snapshot (left while our socket was down) stops showing
        // as a stale "online" ghost, then flip the listed ones online.
        presenceInit(state, action: PayloadAction<ClientData[]>) {
            for (const id in state.byId) state.byId[id].online = false;
            for (const c of action.payload) {
                if (c?.id) state.byId[c.id] = { ...c, online: true };
            }
        },
        // PRESENT_JOIN — a peer came online.
        presenceJoin(state, action: PayloadAction<ClientData>) {
            const c = action.payload;
            if (c?.id) state.byId[c.id] = { ...c, online: true };
        },
        // PRESENT_LEAVE — a peer went offline (keep the known name/email).
        presenceLeave(state, action: PayloadAction<ClientData>) {
            const c = action.payload;
            if (c?.id) state.byId[c.id] = { ...(state.byId[c.id] ?? c), ...c, online: false };
        },
    },
    extraReducers: (builder) => {
        // Drop the whole presence directory on logout so a new session doesn't inherit stale peers.
        builder.addCase(clearUser, (state) => {
            state.byId = {};
        });
    },
});

export const { presenceInit, presenceJoin, presenceLeave } = presenceSlice.actions;
export default presenceSlice.reducer;
