import i18n from "@/shared/i18n";
import {logger} from "@/shared/logger/logger.ts";
import {playNotificationSound} from "@/shared/sound/notify.ts";
import {isNativeApp, push} from "@/shared/platform.ts";
import {isAppBackgrounded} from "@/infrastructure/native/appLifecycle.ts";
import {showDesktopNotification} from "@/features/notifications";
import {chatOnScreen, pageHidden} from "@/features/chat/model/onScreen.ts";
import type {Incoming} from "./record.ts";
import type {IncomingStore} from "./types.ts";

/**
 * Step 3 of an incoming message — the Android app is told (spec 002 §3.3) BEFORE the message is
 * acknowledged. The app notes the message id, so a late push of the same message shows nothing, and shows a
 * notification itself when the user is not looking at THIS chat (`hidden`): the app off the screen (the
 * socket stays open for a moment after the app leaves the screen, and for the whole of a call), or the app
 * on the screen with another chat or the chat list open (spec 002 §5, case 5). A copy is told, never shown.
 *
 * The app's answer, or undefined: not the app, or an app without `notifyMessage` (before 10191) — then the
 * message is acknowledged at once (acknowledge.ts).
 */
export function tellApp(store: IncomingStore, m: Incoming, messageId: string | undefined): Promise<unknown> | undefined {
    if (!isNativeApp()) return undefined;
    const looking = m.chatId === chatOnScreen(store.getState().chatUi?.selectedChatId);
    try {
        return push().notifyMessage({
            conversationId: m.chatId, messageId: messageId ?? m.row.id, senderId: m.senderId,
            hidden: !m.copy && (!looking || pageHidden() || isAppBackgrounded()),
        });
    } catch (e) {
        logger.warn("push: no notifyMessage in this app", e as Error);
        return undefined;
    }
}

/**
 * The user is not looking at the chat (browser only): a sound, and when the page is hidden a notification. The
 * server message id goes with it, so the service worker drops an offline Web Push of the SAME message. The
 * body is the text, or a generic "attachment" / "encrypted message" — never a file name. The title stays
 * generic; the service worker puts the sender's name in from its cache (as for a Web Push). The Android app
 * shows its own notification (tellApp).
 */
export function notifyUser(m: Incoming): void {
    // The Android app sounds its own notification (tellApp: `hidden` for any chat not on the screen) — a second
    // sound from the page would play over it.
    if (isNativeApp()) return;
    playNotificationSound();
    if (!pageHidden()) return;
    const body = m.envelope ? i18n.t("chat.encryptedMessage")
        : m.row.kind === "attachment" ? i18n.t("chat.attachment") : (m.row.text || "");
    showDesktopNotification(i18n.t("chat.newMessage"), body, m.chatId, m.row.id, m.senderId);
}
