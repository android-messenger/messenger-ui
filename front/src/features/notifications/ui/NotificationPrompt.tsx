import {useState} from "react";
import {useTranslation} from "react-i18next";
import {ensurePushSubscription, pushSupported} from "@/features/notifications/push.ts";
import {logger} from "@/shared/logger/logger.ts";

const DISMISS_KEY = "notif-prompt-dismissed";

/**
 * Explicit "enable notifications" banner.
 *
 * Auto-requesting permission on a synthetic/first gesture is unreliable on mobile PWAs (iOS in
 * particular requires the request to run inside a genuine, explicit user activation). A visible
 * button whose onClick calls Notification.requestPermission() SYNCHRONOUSLY is the robust path that
 * actually surfaces the OS prompt on Android and installed iOS PWAs. Shown only when Web Push is
 * supported and permission is still "default" (never for granted/denied — the OS won't re-prompt),
 * and hidden once the user acts or dismisses (persisted so we don't nag).
 */
export function NotificationPrompt() {
    const {t} = useTranslation();
    const [hidden, setHidden] = useState(() => {
        try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
    });

    const canAsk = pushSupported() && typeof Notification !== "undefined" && Notification.permission === "default";
    if (hidden || !canAsk) return null;

    const enable = () => {
        // Synchronous request inside the click = a real user activation (required by iOS PWA).
        try {
            Notification.requestPermission()
                .then((p) => { if (p === "granted") ensurePushSubscription(); })
                .catch((err) => logger.warn("notif permission request failed", {err}));
        } catch (err) {
            logger.warn("notif permission threw", {err});
        }
        setHidden(true);
    };

    const dismiss = () => {
        try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore */ }
        setHidden(true);
    };

    return (
        <div className="absolute top-0 inset-x-0 z-40 flex items-center gap-3 bg-teal-900 text-white
                        px-4 py-2 text-sm shadow">
            <span className="flex-1">{t("notify.enablePrompt")}</span>
            <button onClick={enable}
                    className="px-3 py-1 rounded bg-white text-teal-900 font-medium hover:bg-gray-100">
                {t("notify.enable")}
            </button>
            <button onClick={dismiss} aria-label={t("notify.later")}
                    className="px-2 py-1 rounded hover:bg-teal-800">
                {t("notify.later")}
            </button>
        </div>
    );
}
