import {idsApi, idsDisplayName, type IdsUser} from "./idsApi.ts";

/**
 * Best-effort display name for a user id, read from the LIVE idsApi RTK-Query cache (populated by the
 * directory load in useContacts) — NO extra backend call. Returns undefined when the directory hasn't
 * cached that user yet (e.g. a cold start before the chat list loaded), so callers fall back to a generic
 * label. FULLY defensive: any missing/odd cache shape returns undefined; never throws.
 *
 * idsDisplayName falls back to the raw id when a user has no name/email; we treat that as "unknown" so a
 * notification never shows an opaque id.
 */
export function selectUserName(state: unknown, id: string): string | undefined {
    try {
        const slice = (state as Record<string, unknown> | undefined)?.[idsApi.reducerPath] as
            { queries?: Record<string, { data?: unknown }> } | undefined;
        const queries = slice?.queries;
        if (!queries) return undefined;
        for (const key of Object.keys(queries)) {
            const data = queries[key]?.data;
            if (!data || typeof data !== "object" || Array.isArray(data)) continue;
            const u = (data as Record<string, IdsUser>)[id];
            if (!u) continue;
            const n = idsDisplayName(u);
            if (n && n !== u.id) return n;
        }
    } catch { /* ignore — generic label */ }
    return undefined;
}
