// Captures the browser's `beforeinstallprompt` event so the app can offer a real "Install" button later
// (the event fires once, early — you can't summon it on demand, you must stash it). Imported for its side
// effect from main.tsx so the listener is armed at boot. On browsers that don't fire it (iOS Safari), the
// UI falls back to text instructions.

interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{outcome: "accepted" | "dismissed"}>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;

if (typeof window !== "undefined") {
    window.addEventListener("beforeinstallprompt", (e) => {
        e.preventDefault();                 // stop the mini-infobar; we present our own button
        deferred = e as BeforeInstallPromptEvent;
    });
    window.addEventListener("appinstalled", () => { installed = true; deferred = null; });
}

/** True while a native install prompt is available to trigger. */
export function canInstall(): boolean { return !!deferred; }

/** True if the app is already running as an installed PWA (standalone / home-screen). */
export function isStandalone(): boolean {
    try {
        return !!window.matchMedia?.("(display-mode: standalone)")?.matches
            || (navigator as {standalone?: boolean}).standalone === true;
    } catch { return false; }
}

export function wasInstalled(): boolean { return installed; }

/** Trigger the native install prompt. Returns true if the user accepted. No-op (false) if none is pending. */
export async function promptInstall(): Promise<boolean> {
    if (!deferred) return false;
    const e = deferred;
    deferred = null;                        // a captured prompt can be used only once
    try {
        await e.prompt();
        const choice = await e.userChoice;
        return choice.outcome === "accepted";
    } catch {
        return false;
    }
}
