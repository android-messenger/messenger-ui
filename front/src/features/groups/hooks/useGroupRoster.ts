import {useCallback, useMemo} from "react";
import {useSelector} from "react-redux";
import type {RootState} from "@/store/store";
import {idsDisplayName, useGetIdsUsersByIdsQuery} from "@/features/directory";
import {useGetGroupMembersQuery} from "../rest/groupApi.ts";

/**
 * A group's roster (GET /api/groups/{id}/members — REST-authoritative) enriched for the UI: member
 * count, online count (roster ∩ the global presence set), and a name resolver (IDS directory, then
 * presence, then the id). `refetch` backs the self-heal path (a message from a sender not in the
 * cached roster → refetch). Skipped entirely for 1:1.
 */
export function useGroupRoster(groupId: string | null, isGroup: boolean) {
    const {data: members = [], refetch} = useGetGroupMembersQuery(
        {groupId: groupId ?? ""},
        {skip: !isGroup || !groupId},
    );
    const memberIds = useMemo(() => members.map((m) => m.userId), [members]);
    const idsKey = useMemo(() => [...memberIds].sort(), [memberIds]);
    const {data: idsById = {}} = useGetIdsUsersByIdsQuery(idsKey, {skip: idsKey.length === 0});
    const presence = useSelector((s: RootState) => s.presence.byId);

    const onlineCount = useMemo(
        () => memberIds.filter((id) => presence[id]?.online).length,
        [memberIds, presence],
    );
    const nameOf = useCallback(
        (id: string): string => {
            const d = idsById[id];
            return (d ? idsDisplayName(d) : undefined) || presence[id]?.name || id;
        },
        [idsById, presence],
    );

    return {members, memberIds, memberCount: members.length, onlineCount, nameOf, refetch};
}
