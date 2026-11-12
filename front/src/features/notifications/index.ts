// Public API of the notifications feature. Other features/layers import from here, never from the
// internal push.ts / desktopNotification.ts / ui files.
export {ensurePushSubscription, removePushSubscription, pushSupported} from "./push.ts";
export {
    showDesktopNotification,
    showCallNotification,
    requestNotificationPermission,
    armNotificationPermissionOnGesture,
} from "./desktopNotification.ts";
export {NotificationPrompt} from "./ui/NotificationPrompt.tsx";
