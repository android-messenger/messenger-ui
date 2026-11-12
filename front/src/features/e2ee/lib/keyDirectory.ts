// Client for the key directory service (X3DH prekey directory). Reaches it same-origin through
// the Ory edge at /key-directory/v1 — the Kratos session cookie rides along, and Oathkeeper injects the
// caller's X-User-Id (we never send it). The service stores/serves PUBLIC keys only; all crypto is local.
// Contract mirrors the service's dto.go (public keys are standard base64 strings).

import {API_ORIGIN} from "@/shared/config/api.ts";

const BASE = API_ORIGIN + "/key-directory/v1"; // API_ORIGIN: the app build (shared/config/api.ts)

export interface PreKeyPub { id: number; publicKey: string }               // base64
export interface SignedPreKeyPub { id: number; publicKey: string; signature: string }

/** KEY_PUBLISH body — userId is taken from the auth header, never sent. */
export interface PublishBody {
    deviceId: string;
    identityKey: string;                 // base64 public identity key
    signedPreKey: SignedPreKeyPub;
    oneTimePreKeys: PreKeyPub[];
    lastResortPreKey?: PreKeyPub;        // reusable prekey served when the normal pool is exhausted
}

export interface DeviceBundle {
    deviceId: string;
    identityKey: string;
    signedPreKey: SignedPreKeyPub;
    oneTimePreKey: PreKeyPub | null;     // null only when the pool is exhausted AND no last-resort key
    oneTimePreKeyIsLastResort?: boolean; // true → oneTimePreKey is the reusable last-resort key
    oneTimePreKeysRemaining: number;
}
export interface FetchResponse { userId: string; devices: DeviceBundle[] }
export interface CountResponse { deviceId: string; oneTimePreKeysRemaining: number }

class KeyDirectoryError extends Error {
    status: number;
    constructor(status: number, msg: string) { super(msg); this.name = "KeyDirectoryError"; this.status = status; }
}

const RL_MAX_RETRIES = 3;                                     // KEY_FETCH is per-caller rate-limited server-side
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function req<T>(path: string, init?: RequestInit): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(BASE + path, {
            ...init,
            credentials: "include",                              // Kratos session cookie
            headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
        });
        // 429 Too Many Requests (fetch rate limit): back off and retry a bounded number of times, honoring
        // Retry-After, so a transient burst doesn't surface as a failed session/call instead of a brief wait.
        if (res.status === 429 && attempt < RL_MAX_RETRIES) {
            const ra = Number(res.headers.get("Retry-After"));
            const waitMs = (Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(1000 * 2 ** attempt, 8000)) + Math.random() * 250;
            await res.text().catch(() => {});                   // drain the body before retrying
            await sleep(waitMs);
            continue;
        }
        if (!res.ok) throw new KeyDirectoryError(res.status, `${init?.method ?? "GET"} ${path} → ${res.status}`);
        // 204/empty bodies (publish/replenish may return a small JSON; tolerate empty).
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
    }
}

/** Publish/replace this device's identity + signed prekey and seed its one-time-prekey pool. */
export function publishKeys(body: PublishBody): Promise<CountResponse> {
    return req<CountResponse>("/keys", { method: "POST", body: JSON.stringify(body) });
}

/** Top up this device's one-time-prekey pool (low-water replenishment). */
export function replenishOneTime(deviceId: string, oneTimePreKeys: PreKeyPub[]): Promise<CountResponse> {
    return req<CountResponse>("/keys/one-time", { method: "POST", body: JSON.stringify({ deviceId, oneTimePreKeys }) });
}

/** How many one-time prekeys this device has left (drives replenishment). */
export function selfCount(deviceId: string): Promise<CountResponse> {
    return req<CountResponse>(`/keys/self/count?deviceId=${encodeURIComponent(deviceId)}`);
}

/**
 * Delete this device's record (identity, signed prekey, one-time prekeys) — on logout. The service
 * answers 204; 404 when there is no such record; 409 when a browser session asks to delete a record
 * published by the phone. The caller treats every failure as "not removed", never as a failed logout.
 */
export function deleteSelf(deviceId: string): Promise<void> {
    return req<void>(`/keys/self/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
}

/**
 * Fetch a peer's bundles — one per usable device — to start X3DH. NOTE: this CONSUMES one one-time
 * prekey per device server-side, so only call it when actually establishing a session, not speculatively.
 * A device with an exhausted pool returns oneTimePreKey=null (X3DH falls back to signed-prekey only).
 */
export async function fetchUserKeys(userId: string): Promise<FetchResponse> {
    try {
        return await req<FetchResponse>(`/keys/${encodeURIComponent(userId)}`);
    } catch (e) {
        // A peer who has never published keys is a 404 — that's "no keys yet", NOT an error. Return an
        // empty roster so the caller can give a clear "contact hasn't enabled encryption" message instead
        // of a generic failure. Any OTHER status is a real error and re-throws.
        if (e instanceof KeyDirectoryError && e.status === 404) return { userId, devices: [] };
        throw e;
    }
}

/** Fetch one specific device's bundle (also consumes an OPK for that device). */
export function fetchDeviceKeys(userId: string, deviceId: string): Promise<{ userId: string; device: DeviceBundle }> {
    return req(`/keys/${encodeURIComponent(userId)}/${encodeURIComponent(deviceId)}`);
}

/** Short-lived TURN credentials (coturn use-auth-secret). Fetched before a call; no static creds in the bundle. */
export interface TurnCreds { username: string; credential: string; ttl: number; uris: string[] }
export function fetchTurnCredentials(): Promise<TurnCreds> {
    return req<TurnCreds>("/turn/credentials");
}

export { KeyDirectoryError };
