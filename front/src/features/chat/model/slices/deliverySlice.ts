import {createSlice, type PayloadAction} from "@reduxjs/toolkit";
import {clearUser} from "@/features/auth";
import {sealing} from "@/features/chat/db/sealed.ts";

/**
 * What the delivery of messages remembers between events (spec 003, FR-052) — in the store, not in
 * variables of modules: it is seen in the Redux tools and goes with the store.
 *
 *  - `unreadAskedUnder`: the connection of the socket the "unread" marks were last asked under (spec 002
 *    §3.2; useReconnectCatchup). Forgotten with the user (a 401, a sign-out): the next session asks again.
 *  - `listsReady`: the sealed lists are in the store (model/sealedLists.ts). In a browser they are read at
 *    once: true from the start. Not forgotten with the user: a sign-out empties the lists in memory and on
 *    the disk, and empty is what they are; another account found at sign-in reads them again
 *    (dropForeignCache).
 */
export interface DeliveryState {
    unreadAskedUnder: number | null;
    listsReady: boolean;
}

const initialState = (): DeliveryState => ({unreadAskedUnder: null, listsReady: !sealing()});

const deliverySlice = createSlice({
    name: "delivery",
    initialState,
    reducers: {
        unreadAsked(state, action: PayloadAction<number>) { state.unreadAskedUnder = action.payload; },
        listsRead(state, action: PayloadAction<boolean>) { state.listsReady = action.payload; },
    },
    extraReducers: (builder) => {
        builder.addCase(clearUser, (state) => { state.unreadAskedUnder = null; });
    },
});

export const {unreadAsked, listsRead} = deliverySlice.actions;
export default deliverySlice.reducer;
