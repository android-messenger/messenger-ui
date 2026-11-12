import { useEffect } from "react";
import {useDispatch, useSelector} from "react-redux";
import type {RootState} from "@/store/store.ts";
import {isNotLogged} from "@/shared/utils/checks.ts";
import {messengerWsUrl} from "@/shared/config/api.ts";
import {isAppBackgrounded} from "@/infrastructure/native/appLifecycle.ts";

export function useWebSocketConnection() {

    const dispatch = useDispatch();
    const myId = useSelector((state: RootState) => state.user.id);

    useEffect(() => {
        if (isNotLogged(myId)) return;
        // Host-relative through the Ory edge (same origin as the logged-in window), which
        // authenticates the Kratos session cookie and injects X-User-* on the /ws upgrade.
        // No clientId query — the backend derives the sender from the header identity.
        const url = messengerWsUrl();

        const connect = () =>
            dispatch({ type: "ws/connect", payload: { url }, meta: { shouldReconnect: true } });

        connect();

        // A backgrounded tab (esp. on mobile) can come back with a dead socket while the browser
        // suspended our reconnect timer. Reconnect immediately when the tab is visible again or the
        // network returns. ws/connect is idempotent (no-ops if a socket is already OPEN/CONNECTING),
        // so firing these liberally is safe.
        const onWake = () => {
            // Android app in the background (S1 §7.0): stay disconnected so the backend pushes.
            if (isAppBackgrounded()) return;
            if (document.visibilityState === "visible" && navigator.onLine) connect();
        };
        document.addEventListener("visibilitychange", onWake);
        window.addEventListener("online", onWake);

        return () => {
            document.removeEventListener("visibilitychange", onWake);
            window.removeEventListener("online", onWake);
            dispatch({ type: "ws/disconnect" });
        };
    }, [myId, dispatch]);
}
