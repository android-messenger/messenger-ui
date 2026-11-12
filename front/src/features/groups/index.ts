// Public API of the groups feature (ADR-024 group chats).
export {
    useGetGroupsQuery,
    useCreateGroupMutation,
    useGetGroupMembersQuery,
    useLazyGetGroupMembersQuery,
    useAddGroupMemberMutation,
    useLeaveGroupMutation,
} from "./rest/groupApi.ts";
export type {GroupMember, GroupListItem} from "./rest/groupApi.ts";
export {useGroupRoster} from "./hooks/useGroupRoster.ts";
export {RosterPanel} from "./ui/RosterPanel.tsx";
