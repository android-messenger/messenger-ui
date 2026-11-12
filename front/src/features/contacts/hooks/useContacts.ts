import {useSelector} from "react-redux";
import type {RootState} from "@/store/store.ts";
import {useGetChatsQuery} from "@/features/chat/rest/chatApi.ts";
import type {ChatSummary} from "@/entities/conversation";
import type {Contact} from "@/entities/contact";
import {isNotLogged} from "@/shared/utils/checks.ts";
import {idsDisplayName, useGetIdsUsersByIdsQuery} from "@/features/directory";
import {saveNames, loadNames} from "@/features/directory/nameCache.ts";
import {useGetGroupsQuery} from "@/features/groups";
import {toGroupSummary} from "@/entities/conversation";
import {useEffect, useMemo, useState} from "react";
import {useTranslation} from "react-i18next";

export function useContacts() {
    const {t} = useTranslation();
    const myId = useSelector((state: RootState) => state.user.id);
    const presence = useSelector((state: RootState) => state.presence.byId);
    const skip = isNotLogged(myId);

    // The chat list spans TWO resources in the deployed backend (variant A — separate, not unioned):
    // DIRECT chats (GET /api/chats) and GROUPS (GET /api/groups). Fetch both and merge.
    const {data: directSummaries = [], isLoading: chatsLoading, isError: chatsError} = useGetChatsQuery({myId}, {skip});
    const {data: groupItems = [], isLoading: groupsLoading, isError: groupsError} = useGetGroupsQuery(undefined, {skip});
    const isLoading = chatsLoading || groupsLoading;
    // Either list failing means `summaries` is incomplete — consumers that reconcile against it (the orphan
    // cache sweep) must treat that as "don't trust this set", never as "these chats no longer exist".
    const isError = chatsError || groupsError;
    // Sticky DIRECT chats the user engaged with but the backend hides (empty → omitted from
    // /api/chats). Merge in only those NOT already returned by the backend (a chat with activity comes
    // from getChats and wins). Groups aren't stickied (getGroups already lists them all).
    const sticky = useSelector((state: RootState) => state.stickyChats.byId);
    // Unread flags per conversation (READ_IN/READ_OUT driven). Chats with unread float to the top.
    const unreadByChat = useSelector((state: RootState) => state.chatUi.unreadByChat);
    const summaries = useMemo(() => {
        const backendIds = new Set(directSummaries.map((s) => s.conversationId));
        const stickyExtra = Object.values(sticky).filter((s) => !backendIds.has(s.conversationId));
        return [...directSummaries, ...stickyExtra, ...groupItems.map(toGroupSummary)];
    }, [directSummaries, groupItems, sticky]);

    // Resolve only the 1:1 chat counterparts by id (stable, de-duped key). Groups carry no counterpart
    // (counterpartId ""), so they're excluded — a group's name comes from its own summary.
    const counterpartIds = useMemo(
        () => Array.from(new Set(
            summaries.filter((s) => s.kind !== "group").map((s) => s.counterpartId)
        )).sort(),
        [summaries]
    );
    const {data: idsById = {}} = useGetIdsUsersByIdsQuery(counterpartIds, {
        skip: skip || counterpartIds.length === 0,
    });

    // Mirror resolved id→name into a PERSISTENT store so the service worker can name Web Push
    // notifications while the app is closed (the RTK cache above is in-memory only). Best-effort.
    useEffect(() => {
        const map: Record<string, string> = {};
        for (const [id, u] of Object.entries(idsById)) {
            const n = idsDisplayName(u);
            if (n && n !== id) map[id] = n;   // skip the id-fallback (not a real name)
        }
        if (Object.keys(map).length) void saveNames(map);
    }, [idsById]);

    // READ-THROUGH: seed names from the persistent cache once on mount so a cold start shows real names
    // immediately (while the IDS query above re-fetches), instead of briefly rendering ids/emails. The
    // live idsById always WINS over the cache below, so fresh data supersedes the seed.
    const [cachedNames, setCachedNames] = useState<Record<string, string>>({});
    useEffect(() => { void loadNames().then(setCachedNames).catch(() => {}); }, []);

    // Names resolve from the IDS directory (all users), then presence (online peers), then the
    // order label / identity id. Online status comes from presence (PRESENT_* frames). A GROUP renders
    // from its own summary: its name, a group kind, and no presence (no single peer).
    const contacts = useMemo<Contact[]>(
        () => summaries.map((s): Contact => {
            if (s.kind === "group") {
                return {
                    id: s.conversationId,
                    kind: "group" as const,
                    name: s.name || t("chat.group"),
                    last: "",
                    email: "",
                    online: false,
                };
            }
            const ids = idsById[s.counterpartId];
            const p = presence[s.counterpartId];
            const name =
                (ids ? idsDisplayName(ids) : undefined) ||   // live directory (freshest) wins
                cachedNames[s.counterpartId] ||               // persistent cache (instant on cold start)
                p?.name ||
                (s.orderId ? `Order ${s.orderId}` : s.counterpartId);
            return {
                id: s.conversationId,
                kind: "direct" as const,
                name,
                last: "",
                email: ids?.email || p?.email || s.counterpartId,
                online: p?.online ?? false,
            };
        })
            // Unread first, then alphabetically by name (locale-aware, case-insensitive). Chats don't
            // reorder as messages arrive — only an unread flag lifts one to the top; opening it (which
            // clears unread) drops it back into its alphabetical slot.
            .sort((a, b) => {
                const ua = unreadByChat[a.id] ? 1 : 0;
                const ub = unreadByChat[b.id] ? 1 : 0;
                if (ua !== ub) return ub - ua;
                return a.name.localeCompare(b.name, undefined, {sensitivity: "base"});
            }),
        [summaries, presence, idsById, cachedNames, unreadByChat, t]
    );

    const getContactById = useMemo(
        () => (id: string): Contact | null => contacts.find(c => c.id === id) ?? null,
        [contacts]
    );

    const getContactByName = useMemo(
        () => (name: string): Contact | null => contacts.find(c => c.name === name) ?? null,
        [contacts]
    );

    const getSummary = useMemo(
        () => (conversationId: string): ChatSummary | null =>
            summaries.find(s => s.conversationId === conversationId) ?? null,
        [summaries]
    );

    return {
        contacts,
        summaries,
        getContactById,
        getContactByName,
        getSummary,
        // back-compat aliases for existing consumers
        isLoadingIds: isLoading,
        isLoadingUsers: false,
        isErrorIds: isError,
        isErrorUsers: false,
    };
}