import {useDispatch, useSelector} from "react-redux";
import {useTranslation} from "react-i18next";
import type {RootState} from "@/store/store";
import {messengerWsUrl} from "@/shared/config/api.ts";

// Thin top bar reflecting the WebSocket connection state (nothing surfaced ws.status before, so the
// user had no way to tell they were offline / reconnecting — queued messages just sat on 🕐).
export function ConnectionBanner() {
    const {t} = useTranslation();
    const dispatch = useDispatch();
    const status = useSelector((s: RootState) => s.ws.status);
    const superseded = useSelector((s: RootState) => s.ws.superseded);

    // Take-over (4409): another tab/device holds the single active session and we stopped
    // auto-reconnecting. Explain it and let the user reclaim the session HERE with one tap (rebuilds
    // the same host-relative ws URL as useWebSocketConnection and reconnects; the new session then
    // supersedes the other one). Distinct amber→sky styling so it doesn't read as a plain outage.
    if (superseded) {
        const reclaim = () => {
            const url = messengerWsUrl();
            dispatch({type: "ws/connect", payload: {url}, meta: {shouldReconnect: true}});
        };
        return (
            <div className="absolute top-0 inset-x-0 z-40 flex items-center justify-center gap-2 text-xs py-1 bg-sky-600 text-white">
                <span>{t("chat.sessionElsewhere")}</span>
                <button onClick={reclaim} className="underline font-medium hover:opacity-80">
                    {t("chat.reconnectHere")}
                </button>
            </div>
        );
    }

    if (status === "connected") return null;
    return (
        <div className="absolute top-0 inset-x-0 z-40 text-center text-xs py-1 bg-amber-500 text-white">
            {status === "connecting" ? t("chat.connecting") : t("chat.noConnection")}
        </div>
    );
}
