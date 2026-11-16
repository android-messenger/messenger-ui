import i18n from "@/shared/i18n";
import {logger} from "@/shared/logger/logger.ts";
import {playNotificationSound} from "@/shared/sound/notify.ts";
import {isNativeApp, push} from "@/shared/platform.ts";
import {isAppBackgrounded} from "@/infrastructure/native/appLifecycle.ts";
import {showDesktopNotification} from "@/features/notifications";
import {pageHidden} from "@/features/chat/model/onScreen.ts";
import type {Incoming} from "./record.ts";

/**
 * Step 3 of an incoming message — the Android app is told (spec 002 §3.3) BEFORE the message is
 * acknowledged. The app notes the message id, so a late push of the same message shows nothing, and shows a
 * notification itself when the user is not looking at the app (the socket stays open for a moment after the
 * app leaves the screen, and for the whole of a call). A copy is told, never shown.
 *
 * The app's answer, or undefined: not the app, or an app without `notifyMessage` (before 10191) — then the
 * message is acknowledged at once (acknowledge.ts).
 */
export function tellApp(m: Incoming, messageId: string | undefined): Promise<unknown> | undefined {
    if (!isNativeApp()) return undefined;
    try {
        return push().notifyMessage({
            conversationId: m.chatId, messageId: messageId ?? m.row.id, senderId: m.senderId,
            hidden: !m.copy && (pageHidden() || isAppBackgrounded()),
        });
    } catch (e) {
        logger.warn("push: no notifyMessage in this app", e as Error);
        return undefined;
    }
}

/**
 * The user is not looking at the chat: a sound, and in a browser whose page is hidden a notification. The
 * server message id goes with it, so the service worker drops an offline Web Push of the SAME message. The
 * body is the text, or a generic "attachment" / "encrypted message" — never a file name. The title stays
 * generic; the service worker puts the sender's name in from its cache (as for a Web Push). The Android app
 * shows its own notification (tellApp).
 */
export function notifyUser(m: Incoming): void {
    playNotificationSound();
    if (!pageHidden() || isNativeApp()) return;
    const body = m.envelope ? i18n.t("chat.encryptedMessage")
        : m.row.kind === "attachment" ? i18n.t("chat.attachment") : (m.row.text || "");
    showDesktopNotification(i18n.t("chat.newMessage"), body, m.chatId, m.row.id, m.senderId);
}
