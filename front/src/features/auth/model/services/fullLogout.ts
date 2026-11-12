import type {AppDispatch} from "@/store/store.ts";
import {logout} from "@/features/auth/model/services/kratosFlows.ts";
import {logoutResetClientState} from "@/store/logout.ts";
import {removePushSubscription} from "@/features/notifications";
import {apiOrigin} from "@/shared/config/api.ts";
import {removeFromKeyDirectory, wipeE2eeData} from "@/features/e2ee";

/**
 * The logout sequence (S1 §6 order): push subscription and key-directory record (both need the live
 * session) → client state → E2EE keys and secret data → Kratos session. Shared by the LogoutPage and the
 * D17 "app only" page. Never throws. The caller leaves with goLoginAfterLogout() — a full page load, so
 * no key and no open database handle stays in memory (spec 001, FR-004).
 */
export async function fullLogout(dispatch: AppDispatch): Promise<void> {
    // Drop this device's push subscription while the session cookie is still valid (the
    // DELETE is cookie-authed) so the next user here doesn't inherit our notifications.
    await removePushSubscription().catch(() => {});
    // Same for this device's record in the key directory: a peer must get "no keys", not encrypt to a
    // key that is erased below. Best-effort — a refusal or an unreachable directory does not stop a logout.
    await removeFromKeyDirectory();
    let target: string | null = null;
    try {
        // Kratos returns the full public logout URL (…/.ory/kratos/public/self-service/logout?token=…).
        // Keep its path/query, just pin to the API origin (handles an internal kratos host).
        const logoutUrl = new URL(await logout());
        target = `${apiOrigin()}${logoutUrl.pathname}${logoutUrl.search}`;
    } catch { /* no session or Kratos unreachable: still reset the client */ }
    dispatch(logoutResetClientState());
    // Finding 13: the E2EE keys, the stored secret messages and the marks go with the account. After the
    // reset above (it empties the in-memory secret-chat set, whose subscriber writes localStorage).
    await wipeE2eeData();
    // Invalidate the Kratos session in the background instead of navigating the browser
    // to Kratos (which would bounce to Kratos' default post-logout page). redirect:"manual"
    // means we don't follow Kratos' redirect; the Set-Cookie that clears the session still
    // applies (same-origin), so the session is dead and we control the destination.
    if (target) await fetch(target, {credentials: "include", redirect: "manual"}).catch(() => {});
}

/** Full navigation to the login page after a logout. Separate so tests can replace it. */
export function goLoginAfterLogout(): void {
    window.location.replace(import.meta.env.BASE_URL.replace(/\/$/, "") + "/login");
}
