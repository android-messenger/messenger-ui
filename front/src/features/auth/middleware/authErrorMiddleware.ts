import {createListenerMiddleware, isRejectedWithValue} from "@reduxjs/toolkit";
import toast from "react-hot-toast";
import i18n from "@/shared/i18n";
import {clearUser} from "@/features/auth/slices/userSlice.ts";
import {isNotLogged} from "@/shared/utils/checks.ts";
import {APP_USER_BROWSER_FORBIDDEN, goAppOnly} from "@/features/auth/model/appOnly.ts";

// Global re-auth on 401. Any RTK Query call (chat / ids / contacts) that fails with 401 — a stale
// or expired Kratos session cookie mid-session — triggers a single re-auth flow:
//   toast → clearUser → ws/disconnect.
// clearUser makes RequireAuth redirect to /login on the next render (protected routes) and stops
// the WS reconnect loop (connect() guards on isNotLogged). Guarded so a burst of 401s fires once.
//
// D17: a 403 with X-Device-Deny: APP_USER_BROWSER_FORBIDDEN (this account works only in the Android
// app) → the "app only" page, which logs out. Fires once; other users never get this code.
export const authErrorListener = createListenerMiddleware();
let appOnlyFired = false;

/** The gateway's device-deny code of a failed RTK Query call: header first, then the JSON body. */
function denyCode(action: unknown): string | undefined {
    const a = action as { payload?: { data?: { error?: unknown } }; meta?: { baseQueryMeta?: { response?: { headers?: Headers } } } };
    const h = a.meta?.baseQueryMeta?.response?.headers?.get?.("X-Device-Deny");
    if (h) return h.trim();
    const e = a.payload?.data?.error;
    return typeof e === "string" ? e : undefined;
}

/** Test hook. */
export function resetAppOnlyGuard(): void { appOnlyFired = false; }

authErrorListener.startListening({
    matcher: isRejectedWithValue,
    effect: (action, api) => {
        const status = (action.payload as { status?: number | string } | undefined)?.status;
        if (status === 403 && denyCode(action) === APP_USER_BROWSER_FORBIDDEN) {
            if (appOnlyFired) return;
            appOnlyFired = true;
            api.dispatch({type: "ws/disconnect"});
            goAppOnly();
            return;
        }
        if (status !== 401) return;

        // Already logged out → don't re-fire the toast/redirect on subsequent 401s.
        const userId = (api.getState() as { user?: { id?: string } })?.user?.id ?? "";
        if (isNotLogged(userId)) return;

        toast.error(i18n.t("auth.sessionExpired"));
        api.dispatch(clearUser());
        api.dispatch({type: "ws/disconnect"});
    },
});
