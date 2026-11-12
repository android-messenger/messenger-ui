// Web Push subscription lifecycle against the push service.
//
// Flow: once notification permission is granted and a service worker controls the page, fetch the
// server VAPID public key, subscribe the browser's PushManager, and register the subscription with
// the backend so it can deliver a push when this user is offline. Deregister on logout so the
// device stops receiving another user's notifications. Everything is best-effort and guarded — a
// browser without Push/SW support, a denied permission, or a backend hiccup must never break the app.

import {WEBPUSH_BASE} from "@/shared/config/api";
import {logger} from "@/shared/logger/logger";
import {isNativeApp, push} from "@/shared/platform.ts";

// VAPID public key is base64url; PushManager wants a Uint8Array (applicationServerKey).
function urlBase64ToUint8Array(base64: string): Uint8Array {
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

// True iff an existing subscription's applicationServerKey equals the current server VAPID key
// (byte-for-byte). A mismatch means the subscription is bound to a stale key and must be recreated,
// or the push service (Apple → BadJwtToken) will reject signed sends.
export function applicationServerKeyMatches(existing: ArrayBuffer | null | undefined, want: Uint8Array): boolean {
    if (!existing) return false;
    const a = new Uint8Array(existing);
    if (a.length !== want.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== want[i]) return false;
    return true;
}

export function pushSupported(): boolean {
    return typeof window !== "undefined"
        && "serviceWorker" in navigator
        && "PushManager" in window
        && "Notification" in window;
}

async function fetchVapidKey(): Promise<string | null> {
    try {
        const res = await fetch(`${WEBPUSH_BASE}/vapid-public-key`, {credentials: "include"});
        if (!res.ok) return null;
        const j = (await res.json()) as {publicKey?: string};
        return j.publicKey ?? null;
    } catch {
        return null;
    }
}

/**
 * Ensure this device is subscribed to Web Push and registered with the backend. Idempotent: safe to
 * call on every app start and after permission is granted. No-op unless permission is "granted".
 */
let ensuring = false;

export async function ensurePushSubscription(): Promise<void> {
    // Android app (S1 §6): FCM registration is native (token + payload key → firebase-push); the
    // native side also asks for the notification permission. No Web Push in the app.
    if (isNativeApp()) {
        try {
            const r = await push().register();
            logger.debug("push: native register", r);
        } catch (err) {
            logger.warn("push: native register failed", {err});
        }
        return;
    }
    if (!pushSupported() || Notification.permission !== "granted") return;
    // Reentrancy guard: this can be triggered by several paths at once (mount, gesture arm, the
    // Enable button, a login). Without it, concurrent runs fire duplicate subscribe/register calls.
    if (ensuring) return;
    ensuring = true;
    try {
        const reg = await navigator.serviceWorker.ready;

        const key = await fetchVapidKey();
        if (!key) { logger.warn("push: no VAPID key from server"); return; }
        const appServerKey = urlBase64ToUint8Array(key);

        let sub = await reg.pushManager.getSubscription();
        // Re-subscribe ONLY when the existing subscription's key is READABLE and genuinely DIFFERENT
        // from the current VAPID key. Some browsers (notably iOS Safari) return null for
        // options.applicationServerKey even for a valid subscription — treating that as "mismatch"
        // would unsubscribe a working subscription on every call (churn), so we leave it alone unless
        // we can positively confirm a different key.
        const existingKey = sub?.options?.applicationServerKey;
        if (sub && existingKey && !applicationServerKeyMatches(existingKey, appServerKey)) {
            logger.debug("push: VAPID key changed — re-subscribing");
            await sub.unsubscribe().catch(() => { /* ignore */ });
            sub = null;
        }
        if (!sub) {
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                // Cast: the DOM lib types applicationServerKey as BufferSource; a plain Uint8Array's
                // generic ArrayBufferLike (incl. SharedArrayBuffer) trips strict assignability.
                applicationServerKey: appServerKey as BufferSource,
            });
        }

        // Register (idempotent upsert by endpoint on the backend). PushSubscription.toJSON() gives
        // { endpoint, keys: { p256dh, auth } } — exactly the backend's expected body.
        const json = sub.toJSON() as {endpoint?: string; keys?: {p256dh?: string; auth?: string}};
        const res = await fetch(`${WEBPUSH_BASE}/subscriptions`, {
            method: "POST",
            credentials: "include",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                endpoint: json.endpoint,
                keys: {p256dh: json.keys?.p256dh, auth: json.keys?.auth},
                userAgent: navigator.userAgent,
            }),
        });
        if (!res.ok && res.status !== 201) logger.warn("push: register failed", {status: res.status});
        else logger.debug("push: subscription registered");
    } catch (err) {
        logger.warn("push: ensureSubscription failed", {err});
    } finally {
        ensuring = false;
    }
}

/**
 * Remove this device's push subscription on logout: tell the backend to drop the endpoint, then
 * unsubscribe locally so the next user on this device doesn't inherit it. Best-effort.
 */
export async function removePushSubscription(): Promise<void> {
    // Android app: before the Kratos logout (S1 §9) — the DELETE needs the session.
    if (isNativeApp()) {
        try {
            await push().unregister();
        } catch (err) {
            logger.warn("push: native unregister failed", {err});
        }
        return;
    }
    if (!pushSupported()) return;
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!sub) return;
        const endpoint = sub.endpoint;
        try {
            await fetch(`${WEBPUSH_BASE}/subscriptions?endpoint=${encodeURIComponent(endpoint)}`, {
                method: "DELETE",
                credentials: "include",
            });
        } catch { /* still unsubscribe locally below */ }
        await sub.unsubscribe().catch(() => { /* ignore */ });
        logger.debug("push: subscription removed");
    } catch (err) {
        logger.warn("push: removeSubscription failed", {err});
    }
}
