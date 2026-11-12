import type { Middleware, PayloadAction } from "@reduxjs/toolkit";
import type { WSMessage } from "@/infrastructure/types.ts";
import {
    presenceInit,
    presenceJoin,
    presenceLeave,
    type ClientData,
} from "@/features/presence/model/presenceSlice.ts";

// Backend presence frames carry ClientData as a JSON string in payload.body.
function parseBody<T>(frame: WSMessage): T | null {
    const body = (frame.payload as { body?: string } | undefined)?.body;
    if (!body) return null;
    try {
        return JSON.parse(body) as T;
    } catch {
        return null;
    }
}

// Reacts to every ws/incoming (no clobber from the single lastIncoming slot) and keeps the
// presence directory (id -> name/email/online) up to date from PRESENT_INIT/JOIN/LEAVE.
export const presenceMiddleware: Middleware = (store) => (next) => (action) => {
    const result = next(action);
    const a = action as PayloadAction<WSMessage>;

    if (a?.type === "ws/incoming") {
        const frame = a.payload;
        switch (frame?.type) {
            case "PRESENT_INIT": {
                const list = parseBody<ClientData[]>(frame);
                if (Array.isArray(list)) store.dispatch(presenceInit(list));
                break;
            }
            case "PRESENT_JOIN": {
                const c = parseBody<ClientData>(frame);
                if (c) store.dispatch(presenceJoin(c));
                break;
            }
            case "PRESENT_LEAVE": {
                const c = parseBody<ClientData>(frame);
                if (c) store.dispatch(presenceLeave(c));
                break;
            }
        }
    }

    return result;
};
