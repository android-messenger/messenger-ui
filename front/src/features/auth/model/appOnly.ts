// D17 (ARCHITECTURE): an account registered in the Android app may not use the browser. The gateway
// answers 403 with X-Device-Deny: APP_USER_BROWSER_FORBIDDEN (body {"error": "APP_USER_BROWSER_FORBIDDEN"}).

export const APP_USER_BROWSER_FORBIDDEN = "APP_USER_BROWSER_FORBIDDEN";
export const APP_ONLY_PATH = "/app-only";

/** Full navigation to the "app only" page (it logs out). Separate so tests can replace it. */
export function goAppOnly(): void {
    window.location.replace(import.meta.env.BASE_URL.replace(/\/$/, "") + APP_ONLY_PATH);
}
