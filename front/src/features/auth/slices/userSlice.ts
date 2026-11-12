import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import {anonimo} from "@/shared/utils/checks.ts";
import type {User} from "@/features/auth/model/types.ts";

const initialState: User = {name: anonimo, id: anonimo, initialized: false};

export const userSlice = createSlice({
    name: "user",
    initialState,
    reducers: {
        setUser(state, action: PayloadAction<{ id: string; name: string }>) {
            state.id = action.payload.id;
            state.name = action.payload.name;
            state.initialized = true;
        },
        clearUser(state) {
            state.id = anonimo;
            state.name = anonimo;
            state.initialized = true;
        },
        markInitialized(state) {
            state.initialized = true;
        },
    },
});

export const { setUser, clearUser, markInitialized } = userSlice.actions;
export default userSlice.reducer;
