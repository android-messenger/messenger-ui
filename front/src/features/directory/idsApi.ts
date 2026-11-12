import {createApi, fetchBaseQuery} from "@reduxjs/toolkit/query/react";
import {apiOrigin, PEOPLE_BASE_PATH} from "@/shared/config/api.ts";

// Origin-rooted URL for a session-authed IDS people route (POST /people/search,
// POST /people/batch, GET /people/{id}). All calls carry the Kratos session
// cookie (same-origin); the edge injects X-User-Id. NO admin key is ever sent.
const peopleUrl = (sub: string): string => apiOrigin() + PEOPLE_BASE_PATH + sub;

// IDS (KratosGate) identity directory, reached through the edge and gated purely
// by the Kratos session. Cached once and shared across the app so names resolve
// everywhere (chat list + new-chat search), not only for online peers.
export type IdsUser = {
    id: string;
    email?: string;
    display_name?: string;
    first_name?: string;
    last_name?: string;
    avatar_url?: string;
    locale?: string;
    // No role/status/verified/version: the session-authed /people/* routes do not
    // expose operator fields (gate audit SEC-08).
};

// Adaptive people-search (docs/adaptive-search): a breadcrumb constraint is an
// ANDed equality on a derived discriminator; a refinement is the single best next
// question the server suggests to narrow a large result set.
export type IdsConstraint = {field: string; value: string};
export type IdsRefinement = {
    field: string; // discriminator id, e.g. "surname.initial"
    label: string; // human prompt, e.g. "Filter by surname initial"
    input: "letter" | "letters2" | "text";
    // The values that ACTUALLY occur in the current candidate set (most-populated
    // first), each with its count. The picker offers only these — never the whole
    // alphabet — so every choice really narrows the results.
    options: {value: string; count: number}[];
};

export function idsDisplayName(u: IdsUser): string {
    return (
        u.display_name?.trim() ||
        [u.first_name, u.last_name].filter(Boolean).join(" ").trim() ||
        u.email ||
        u.id
    );
}

export const idsApi = createApi({
    reducerPath: "idsApi",
    baseQuery: fetchBaseQuery({
        // Endpoints use absolute origin-rooted URLs (peopleUrl), so no base path.
        baseUrl: "",
        credentials: "include",
        prepareHeaders: (headers) => {
            headers.set("Accept", "application/json");
            return headers;
        },
    }),
    endpoints: (builder) => ({
        // Adaptive type-ahead over name/email — POST /people/search, session-authed
        // via the edge (X-User-Id). Keyset pagination: pass the previous page's
        // nextToken (the server's opaque next_cursor; a search serves at most 200
        // results, then next_cursor is null). Breadcrumb constraints narrow the
        // set; the response carries the next refinement suggestion.
        searchIdsUsers: builder.query<
            { users: IdsUser[]; nextToken?: string; total: number; refinement?: IdsRefinement },
            { q: string; pageToken?: string; pageSize?: number; constraints?: IdsConstraint[]; wantRefinement?: boolean }
        >({
            query: ({q, pageToken, pageSize = 20, constraints, wantRefinement = true}) => ({
                url: peopleUrl("/search"),
                method: "POST",
                body: {
                    query: q,
                    limit: pageSize,
                    ...(pageToken ? {cursor: pageToken} : {}),
                    ...(constraints && constraints.length ? {constraints} : {}),
                    want_refinement: wantRefinement,
                },
            }),
            transformResponse: (resp: unknown) => {
                const r = resp as {
                    results?: unknown;
                    next_cursor?: string | null;
                    total?: number;
                    refinement?: IdsRefinement | null;
                };
                return {
                    users: Array.isArray(r?.results) ? (r.results as IdsUser[]) : [],
                    nextToken: r?.next_cursor || undefined,
                    total: r?.total ?? 0,
                    refinement: r?.refinement ?? undefined,
                };
            },
        }),
        // A single user by id (e.g. a call peer) —
        // GET /people/{id}, session-authed.
        getIdsUser: builder.query<IdsUser | null, string>({
            query: (id) => peopleUrl(`/${encodeURIComponent(id)}`),
            transformResponse: (resp: unknown): IdsUser | null =>
                resp && (resp as IdsUser).id ? (resp as IdsUser) : null,
        }),
        // Resolve a set of ids into an id -> user map in ONE call —
        // POST /people/batch {ids}. Missing ids are simply omitted. Pass a STABLE
        // (sorted, de-duped) id array so the RTK cache key is stable across renders.
        getIdsUsersByIds: builder.query<Record<string, IdsUser>, string[]>({
            async queryFn(ids, _api, _extra, baseQuery) {
                const unique = Array.from(new Set(ids.filter(Boolean)));
                if (unique.length === 0) return {data: {}};
                const res = await baseQuery({url: peopleUrl("/batch"), method: "POST", body: {ids: unique}});
                if (res.error) return {error: res.error};
                const results = (res.data as {results?: IdsUser[]})?.results ?? [];
                const map: Record<string, IdsUser> = {};
                for (const u of results) {
                    if (u && u.id) map[u.id] = u;
                }
                return {data: map};
            },
        }),
    }),
});

export const {
    useLazySearchIdsUsersQuery,
    useGetIdsUserQuery,
    useGetIdsUsersByIdsQuery,
} = idsApi;
