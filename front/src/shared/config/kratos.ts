import {API_ORIGIN} from "@/shared/config/api.ts";

// Ory Kratos public API. On the edge it is served at `/.ory/kratos/public`
// (same origin as the app, so the existing session cookie applies). Override with
// VITE_KRATOS_URL if the edge mounts it elsewhere.
// The app build puts it on the API origin (see API_ORIGIN).
export const kratosUrl =
    API_ORIGIN + ((import.meta.env.VITE_KRATOS_URL as string | undefined) ?? '/.ory/kratos/public');