// Android app platform layer (S1 §6). The web client runs unchanged in a browser; inside the Android
// app (Capacitor shell, org.wolpmessenger) it reaches native plugins through the bridge the app
// injects into its own origin. No @capacitor/core dependency: the app's bridge provides
// window.Capacitor.Plugins itself, so the browser bundle carries only these few lines.

/** Vault purposes reachable from JS (S1 §5.1); the native side refuses anything else. */
export type VaultPurpose = "e2ee" | "e2ee-plaintext" | "chat-cache";

/** `DeviceTrust` plugin (S1 §5.1). Data and blobs are standard base64. */
export interface DeviceTrustPlugin {
    getState(): Promise<{ state: string; notAfter?: string }>;
    getDeviceInfo(): Promise<{ securityLevel?: "TEE" | "STRONGBOX"; strongBox: boolean; sdkInt: number; securityPatch: string }>;
    vaultWrap(o: { data: string; purpose: VaultPurpose }): Promise<{ blob: string }>;
    vaultUnwrap(o: { blob: string; purpose: VaultPurpose }): Promise<{ data: string }>;
    // Secret chats (spec 001, story 6): the keys and the sessions live in the app's library. `peer` is the
    // peer's account id. A refusal rejects with `code` from the library's closed list (features/e2ee).
    e2eeEncrypt(o: { peer: string; text: string }): Promise<{ envelope: string }>;
    e2eeDecrypt(o: { peer: string; envelope: string }): Promise<{ text: string }>;
    e2eePeerState(o: { peer: string }): Promise<{ trust: "unverified" | "passport" | "verified" | "reverify"; keyChanged: boolean }>;
    e2eeSafetyNumber(o: { peer: string }): Promise<{ digits?: string }>;
    /** `digits` — the safety number that was on the screen; another key by now → refused with `reverify`. */
    e2eeSetVerified(o: { peer: string; verified: boolean; digits?: string }): Promise<void>;
    /** The user closed the "key changed" notice; until then e2eePeerState keeps saying keyChanged. */
    e2eeKeyChangeSeen(o: { peer: string }): Promise<void>;
    e2eeResetSession(o: { peer: string }): Promise<void>;
    /** Sign-out: the app erases its keys, sessions and marks and takes its record out of the key directory. */
    e2eeWipe(): Promise<void>;
    /** Sign-out, the last step: ends the Kratos session if the server answers and erases the cookies anyway. */
    sessionEnd(): Promise<{ ended: boolean }>;
}

/** `Files` plugin (S1 §5.4): the native side downloads `url` (app host only) into a file the user picks. */
export interface FilesPlugin {
    saveDownload(o: { url: string; fileName?: string; mimeType?: string }): Promise<{ saved: boolean; opened?: boolean }>;
}

/** Capacitor's listener handle. */
export interface PluginListenerHandle {
    remove(): Promise<void>;
}

/**
 * Removes a listener whatever `addListener` returned: the app bridge hands back the handle itself, not a
 * Promise (seen on the A37 — `h.then is not a function` crashed NativeAppBridge on unmount).
 */
export function removeListener(h: Promise<PluginListenerHandle> | PluginListenerHandle | null | undefined): void {
    if (!h) return;
    void Promise.resolve(h).then((x) => x?.remove?.()).catch(() => { /* already gone */ });
}

/** Data of a notification tap (S1 §5.2). */
export interface NotificationTapData {
    conversationId?: string;
    /** `accept`: «Принять» on the native incoming-call screen (S1 §7.3) — answer the re-sent offer at once. */
    call?: { conversationId: string; callerId: string; media?: "audio" | "video"; accept?: boolean };
}

/**
 * `Push` plugin (S1 §5.2, §7.0). FCM registration is native; the web app supplies names and the open
 * conversation, and closes its WebSocket on `appBackground` (answering `wsClosed`) so the backend
 * sees the user as absent and pushes.
 */
export interface PushPlugin {
    register(): Promise<{ result?: string }>;
    unregister(): Promise<void>;
    updateContactNames(o: { names: Record<string, string> }): Promise<void>;
    setForegroundConversation(o: { conversationId: string | null }): Promise<void>;
    wsClosed(): Promise<void>;
    addListener(e: "notificationTap", cb: (d: NotificationTapData) => void): Promise<PluginListenerHandle>;
    addListener(e: "appBackground" | "appForeground", cb: () => void): Promise<PluginListenerHandle>;
}

export type AudioRoute = "earpiece" | "speaker" | "bluetooth" | "wired";

/**
 * `Call` plugin (S1 §5.3, §4.5): a foreground service keeps the microphone/camera and the WebSocket
 * while a call runs in the background; native audio routes; `callDecline` when the native incoming
 * screen was declined while our WebSocket may be open (we send the `call:end`).
 */
export interface CallPlugin {
    started(o: { media: "audio" | "video"; conversationId: string; peerName?: string }): Promise<void>;
    /** The ringback tone of an outgoing call, played by the app on the call's audio route (APK 10099+). */
    ringback(o: { on: boolean }): Promise<void>;
    mediaChanged(o: { media: "audio" | "video" }): Promise<void>;
    ended(): Promise<void>;
    getAudioRoutes(): Promise<{ routes: AudioRoute[]; current: AudioRoute | "" }>;
    setAudioRoute(o: { route: AudioRoute }): Promise<void>;
    addListener(e: "audioRouteChanged", cb: (d: { route: AudioRoute }) => void): Promise<PluginListenerHandle>;
    addListener(e: "hangupFromNotification", cb: () => void): Promise<PluginListenerHandle>;
    addListener(e: "audioFocusLost", cb: (d: { transient: boolean }) => void): Promise<PluginListenerHandle>;
    addListener(e: "callDecline", cb: (d: { conversationId: string; callerId: string }) => void): Promise<PluginListenerHandle>;
}

/** `AppSettings` plugin (S1 §5.5): the UI language for native screens and notifications. */
export interface AppSettingsPlugin {
    setLanguage(o: { lang: string }): Promise<void>;
    /** The version of the APK. Absent in an APK older than 10096. */
    getAppInfo?(): Promise<{ versionName: string; versionCode: number }>;
}

interface CapacitorGlobal {
    isNativePlatform?: () => boolean;
    Plugins?: Record<string, unknown>;
}

function capacitor(): CapacitorGlobal | undefined {
    return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** True only inside the Android app (the main frame of the UI packaged into the APK); false in every browser. */
export function isNativeApp(): boolean {
    try {
        return capacitor()?.isNativePlatform?.() === true;
    } catch {
        return false;
    }
}

/** The `DeviceTrust` plugin; throws outside the app. */
export function deviceTrust(): DeviceTrustPlugin {
    const p = isNativeApp() ? capacitor()?.Plugins?.DeviceTrust : undefined;
    if (!p) throw new Error("DeviceTrust plugin is only available in the Android app");
    return p as DeviceTrustPlugin;
}

/** The `Files` plugin; throws outside the app. */
export function files(): FilesPlugin {
    const p = isNativeApp() ? capacitor()?.Plugins?.Files : undefined;
    if (!p) throw new Error("Files plugin is only available in the Android app");
    return p as FilesPlugin;
}

/** The `Call` plugin; throws outside the app. */
export function callPlugin(): CallPlugin {
    const p = isNativeApp() ? capacitor()?.Plugins?.Call : undefined;
    if (!p) throw new Error("Call plugin is only available in the Android app");
    return p as CallPlugin;
}

/** The `AppSettings` plugin; throws outside the app (and in an APK older than 9995, which lacks it). */
export function appSettings(): AppSettingsPlugin {
    const p = isNativeApp() ? capacitor()?.Plugins?.AppSettings : undefined;
    if (!p) throw new Error("AppSettings plugin is only available in the Android app");
    return p as AppSettingsPlugin;
}

/** The `Push` plugin; throws outside the app. */
export function push(): PushPlugin {
    const p = isNativeApp() ? capacitor()?.Plugins?.Push : undefined;
    if (!p) throw new Error("Push plugin is only available in the Android app");
    return p as PushPlugin;
}
