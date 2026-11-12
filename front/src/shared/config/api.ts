// Origin of the edge the APIs live on. Empty for the web build: every URL stays host-relative and
// the browser sends the Kratos session cookie same-origin. The Android app build (`--mode app`, the
// UI packaged into the APK — docs security/09) runs on a local origin and sets it to the app host
// (https://app.<host>): the cookie still goes along, the two origins being same-site, and the
// gateway answers CORS for the packaged UI's origin.
export const API_ORIGIN =
    ((import.meta.env.VITE_API_ORIGIN as string | undefined) ?? "").replace(/\/$/, "");

/** Absolute origin for building URLs: the API origin in the app build, the page's own otherwise. */
export function apiOrigin(): string {
    return API_ORIGIN || (typeof window !== "undefined" ? window.location.origin : "");
}

// Edge prefix under which the messenger backend is exposed on the Ory edge.
// On staging the messenger REST lives at `${origin}/messenger/api/**` and the WS at
// `${origin}/messenger/ws`. All calls are host-relative so the browser sends the
// existing Kratos session cookie (same-origin with the edge). Override per-env with
// VITE_MESSENGER_BASE (e.g. "" if the messenger is mounted at the origin root).
export const MESSENGER_BASE =
    API_ORIGIN + ((import.meta.env.VITE_MESSENGER_BASE as string | undefined) ?? "/messenger");

export const MESSENGER_API = `${MESSENGER_BASE}/api`;

/** The messenger WebSocket: `wss://` on the API origin (the page's own in the web build). */
export function messengerWsUrl(): string {
    const u = new URL(apiOrigin());
    const protocol = u.protocol === "https:" ? "wss" : "ws";
    const path = (import.meta.env.VITE_MESSENGER_BASE as string | undefined) ?? "/messenger";
    return `${protocol}://${u.host}${path}/ws`;
}

// Push service edge prefix (Kratos+Oathkeeper): GET /webpush/vapid-public-key (public) and
// GET/POST/DELETE /webpush/subscriptions (cookie-authed). Host-relative → same-origin session cookie.
export const WEBPUSH_BASE =
    API_ORIGIN + ((import.meta.env.VITE_WEBPUSH_BASE as string | undefined) ?? "/webpush");

// IDS (KratosGate) admin directory for user search. The edge route (host-relative, same
// IDS (KratosGate) identity directory — reached through the edge under /people/**
// and gated by the Kratos SESSION only (Oathkeeper injects X-User-Id). The
// frontend no longer holds any IDS admin key: search, name-by-id and batch all go
// through session-authed routes. Override the base with VITE_PEOPLE_BASE.
export const PEOPLE_BASE_PATH =
    (import.meta.env.VITE_PEOPLE_BASE as string | undefined) ?? "/people";

