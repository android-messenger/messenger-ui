import {describe, it, expect, vi, beforeEach} from "vitest";
import {configureStore, type Reducer} from "@reduxjs/toolkit";
import toast from "react-hot-toast";
import {authErrorListener, resetAppOnlyGuard} from "../authErrorMiddleware";
import {goAppOnly} from "@/features/auth/model/appOnly.ts";
import userReducer from "@/features/auth/slices/userSlice.ts";

vi.mock("react-hot-toast", () => ({default: {error: vi.fn()}}));
vi.mock("@/shared/i18n", () => ({default: {t: (k: string) => k}}));
vi.mock("@/features/auth/model/appOnly.ts", async (orig) => ({...(await orig<object>()), goAppOnly: vi.fn()}));

// A 403 of the gateway: X-Device-Deny header (fetchBaseQuery meta) and/or {"error": …} body.
const denied = (code: string, where: "header" | "body") => ({
    type: "chatApi/executeQuery/rejected",
    payload: {status: 403, data: where === "body" ? {error: code} : {}},
    meta: {
        requestStatus: "rejected", rejectedWithValue: true, requestId: "r", arg: undefined, aborted: false, condition: false,
        baseQueryMeta: where === "header" ? {response: {headers: new Headers({"X-Device-Deny": code})}} : {},
    },
    error: {message: "Rejected"},
});

// A rejected-with-value action shaped like an RTK Query failure with an HTTP status.
const rejected = (status: number) => ({
    type: "chatApi/executeQuery/rejected",
    payload: {status},
    meta: {requestStatus: "rejected", rejectedWithValue: true, requestId: "r", arg: undefined, aborted: false, condition: false},
    error: {message: "Rejected"},
});

function makeStore(userId: string) {
    const seen: string[] = [];
    const recorder: Reducer<Record<string, never>> = (state = {}, action) => { seen.push(action.type); return state; };
    const store = configureStore({
        reducer: {user: userReducer, rec: recorder},
        middleware: (gDM) => gDM().prepend(authErrorListener.middleware),
        preloadedState: {user: {id: userId, name: userId, initialized: true}},
    });
    return {store, seen};
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("authErrorMiddleware", () => {
    beforeEach(() => { vi.mocked(toast.error).mockClear(); vi.mocked(goAppOnly).mockClear(); resetAppOnlyGuard(); });

    it("D17: 403 APP_USER_BROWSER_FORBIDDEN (header) → app-only page once, ws/disconnect", async () => {
        const {store, seen} = makeStore("u1");
        store.dispatch(denied("APP_USER_BROWSER_FORBIDDEN", "header"));
        store.dispatch(denied("APP_USER_BROWSER_FORBIDDEN", "header"));
        await tick();
        expect(goAppOnly).toHaveBeenCalledTimes(1);
        expect(seen).toContain("ws/disconnect");
        expect(toast.error).not.toHaveBeenCalled();
    });

    it("D17: the code in the JSON body alone is enough", async () => {
        const {store} = makeStore("u1");
        store.dispatch(denied("APP_USER_BROWSER_FORBIDDEN", "body"));
        await tick();
        expect(goAppOnly).toHaveBeenCalledTimes(1);
    });

    it("other 403s are not D17", async () => {
        const {store, seen} = makeStore("u1");
        store.dispatch(denied("DEVICE_REVOKED", "header"));
        store.dispatch(rejected(403));
        await tick();
        expect(goAppOnly).not.toHaveBeenCalled();
        expect(seen).not.toContain("user/clearUser");
    });

    it("on a 401 (logged in): toast once + clearUser + ws/disconnect", async () => {
        const {store, seen} = makeStore("u1");
        store.dispatch(rejected(401));
        await tick();
        expect(seen).toContain("user/clearUser");
        expect(seen).toContain("ws/disconnect");
        expect(toast.error).toHaveBeenCalledTimes(1);
    });

    it("is a no-op on a 401 when already logged out (guard)", async () => {
        const {store, seen} = makeStore("Anonimo"); // isNotLogged sentinel
        store.dispatch(rejected(401));
        await tick();
        expect(seen).not.toContain("user/clearUser");
        expect(toast.error).not.toHaveBeenCalled();
    });

    it("ignores a non-401 rejection", async () => {
        const {store, seen} = makeStore("u1");
        store.dispatch(rejected(500));
        await tick();
        expect(seen).not.toContain("user/clearUser");
        expect(toast.error).not.toHaveBeenCalled();
    });
});
