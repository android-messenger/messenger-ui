import {chatApi} from "@/features/chat/rest/chatApi.ts";

/** A group roster entry (GET /api/groups/{id}/members). Flat roles in v1. */
export type GroupMember = { userId: string; role: string };

/** A row of GET /api/groups (the caller's groups) — the group list is its OWN resource (the deployed
 *  backend does NOT union groups into /api/chats; /api/chats is DIRECT-only). */
export type GroupListItem = { id: string; kind: string; name?: string; memberCount: number; updatedAt?: string };

/** Backend Conversation returned by POST /api/groups (a group: null pair, name in metadata.name). */
type CreatedGroup = { id: string; metadata?: Record<string, string> | null };

/**
 * GROUP chat operations (ADR-024). Injected into chatApi so it reuses the same reducer/middleware and
 * tag cache (no extra store wiring). The chat LIST itself stays in chatApi.getChats — groups already
 * arrive there merged with DIRECT chats; this api only covers the group-specific ops the union can't do:
 * create, roster, add member, leave. Roster is REST-authoritative and loaded per-group on open.
 */
export const groupApi = chatApi.injectEndpoints({
    endpoints: (builder) => ({
        // The caller's groups (GET /api/groups) — a separate resource from /api/chats (which is
        // DIRECT-only in the deployed backend). Shares the "Chats" tag so create/leave refetch it.
        getGroups: builder.query<GroupListItem[], void>({
            query: () => `/groups`,
            transformResponse: (r: unknown): GroupListItem[] => (Array.isArray(r) ? r as GroupListItem[] : []),
            providesTags: ["Chats"],
        }),

        // Create a group (creator + members). Any authenticated user may create; not idempotent (a fresh
        // id each call). 422 if <1 other member, 413 over the size cap. Refetch the list so it appears.
        createGroup: builder.mutation<CreatedGroup, { memberIds: string[]; name?: string }>({
            query: ({memberIds, name}) => ({
                url: `/groups`,
                method: "POST",
                body: {memberIds, metadata: name ? {name} : {}},
            }),
            invalidatesTags: ["Chats"],
        }),

        // The group's active roster (source of truth). Namespaced Chat-tag id so it never collides with a
        // conversation history entry; refreshed on add/leave and by the self-heal path.
        getGroupMembers: builder.query<GroupMember[], { groupId: string }>({
            query: ({groupId}) => `/groups/${groupId}/members`,
            providesTags: (_r, _e, a) => [{type: "Chat", id: `group-members:${a.groupId}`}],
        }),

        addGroupMember: builder.mutation<void, { groupId: string; userId: string }>({
            query: ({groupId, userId}) => ({
                url: `/groups/${groupId}/members`,
                method: "POST",
                body: {userId},
            }),
            invalidatesTags: (_r, _e, a) => [{type: "Chat", id: `group-members:${a.groupId}`}],
        }),

        // The caller leaves the group (terminal until re-added) → drops from the list.
        leaveGroup: builder.mutation<void, { groupId: string }>({
            query: ({groupId}) => ({url: `/groups/${groupId}/leave`, method: "POST"}),
            invalidatesTags: ["Chats"],
        }),
    }),
});

export const {
    useGetGroupsQuery,
    useCreateGroupMutation,
    useGetGroupMembersQuery,
    useLazyGetGroupMembersQuery,
    useAddGroupMemberMutation,
    useLeaveGroupMutation,
} = groupApi;
