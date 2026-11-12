import {useCallback, useMemo} from "react";
import {idsDisplayName, useGetIdsUsersByIdsQuery} from "@/features/directory";

/**
 * Resolve the display name of each distinct PEER author in a group's loaded messages, via the IDS
 * directory keyed by senderId (no roster fetch — the senderIds ARE the authors). A 1:1 chat passes
 * isGroup=false and the lookup is skipped. Returns nameOf(senderId) → display name (falls back to the id).
 */
export function useGroupAuthorNames(
    messages: ReadonlyArray<{fromMe: boolean; from?: string}>,
    isGroup: boolean,
): (id?: string) => string | undefined {
    const authorIds = useMemo(
        () => isGroup
            ? Array.from(new Set(
                messages.filter((m) => !m.fromMe && m.from).map((m) => m.from as string)
            )).sort()
            : [],
        [isGroup, messages],
    );
    const {data: authorsById = {}} = useGetIdsUsersByIdsQuery(authorIds, {skip: authorIds.length === 0});
    return useCallback(
        (id?: string): string | undefined => {
            if (!id) return undefined;
            const d = authorsById[id];
            return (d ? idsDisplayName(d) : undefined) || id;
        },
        [authorsById],
    );
}
