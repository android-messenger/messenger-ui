import {API_ORIGIN} from "@/shared/config/api.ts";

// Short-lived TURN credentials for a call (coturn use-auth-secret); no static password is in the bundle.
// Served by the key directory service, same origin through the Ory edge — the session cookie rides along.
// This is the only request the interface makes to that service: the keys are published and fetched by the
// Android app's library.

export interface TurnCreds { username: string; credential: string; ttl: number; uris: string[] }

export async function fetchTurnCredentials(): Promise<TurnCreds> {
    const res = await fetch(API_ORIGIN + "/key-directory/v1/turn/credentials", {credentials: "include"});
    if (!res.ok) throw new Error(`GET /turn/credentials → ${res.status}`);
    return await res.json() as TurnCreds;
}
