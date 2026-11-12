import {appSettings, isNativeApp} from "@/shared/platform.ts";

let reported: string | null = null;

/**
 * S1 §5.5: tell the Android app the UI language so its native screens and notifications (rendered
 * while the web app may be closed) use it too. Best-effort and de-duplicated; a no-op in a browser
 * and in an APK without the plugin.
 */
export function reportNativeLanguage(lng: string | undefined): void {
    if (!lng || lng === reported || !isNativeApp()) return;
    try {
        reported = lng;
        appSettings().setLanguage({lang: lng}).catch(() => { reported = null; });
    } catch {
        reported = null; // older APK: no AppSettings plugin
    }
}

/** Tests only. */
export function resetNativeLanguage(): void { reported = null; }
