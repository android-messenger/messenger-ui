import {useEffect, useState} from "react";
import {useDispatch, useSelector} from "react-redux";
import toast from "react-hot-toast";
import {useTranslation} from "react-i18next";

import type {AppDispatch, RootState} from "@/store/store.ts";
import {setSelectedChatId} from "@/features/chat/model/slices/chatUiSlice.ts";
import {idsDisplayName, useLazySearchIdsUsersQuery, type IdsUser} from "@/features/directory";
import {useAddGroupMemberMutation, useLeaveGroupMutation} from "../rest/groupApi.ts";

/**
 * Group roster panel (modal): the active members with online dots, an inline "add member" directory
 * search, and "leave group". Roster is REST-authoritative — add invalidates it (re-fetch), leave
 * drops the group from the list and closes the window.
 */
export function RosterPanel({
    groupId,
    groupName,
    memberIds,
    nameOf,
    onClose,
}: {
    groupId: string;
    groupName: string;
    memberIds: string[];
    nameOf: (id: string) => string;
    onClose: () => void;
}) {
    const {t} = useTranslation();
    const dispatch = useDispatch<AppDispatch>();
    const presence = useSelector((s: RootState) => s.presence.byId);
    const [addMember, {isLoading: adding}] = useAddGroupMemberMutation();
    const [leaveGroup, {isLoading: leaving}] = useLeaveGroupMutation();

    const [query, setQuery] = useState("");
    const [debounced, setDebounced] = useState("");
    const [items, setItems] = useState<IdsUser[]>([]);
    const [runSearch] = useLazySearchIdsUsersQuery();

    useEffect(() => {
        const h = setTimeout(() => setDebounced(query.trim()), 300);
        return () => clearTimeout(h);
    }, [query]);
    useEffect(() => {
        if (debounced.length < 2) return;   // too short → the render gates the list to []
        let cancelled = false;
        runSearch({q: debounced}).unwrap()
            .then((page) => { if (!cancelled) setItems(page.users.filter((u) => !memberIds.includes(u.id))); })
            .catch(() => { /* ignore */ });
        return () => { cancelled = true; };
    }, [debounced, memberIds, runSearch]);
    const visible = debounced.length < 2 ? [] : items.filter((u) => !memberIds.includes(u.id));

    async function add(u: IdsUser) {
        try {
            await addMember({groupId, userId: u.id}).unwrap();
            setQuery(""); setItems([]);
        } catch (e) {
            toast.error((e as {status?: number})?.status === 413 ? t("group.tooManyMembers") : t("group.addError"));
        }
    }

    async function leave() {
        try {
            await leaveGroup({groupId}).unwrap();
            dispatch(setSelectedChatId(null));
            onClose();
        } catch {
            toast.error(t("group.leaveError"));
        }
    }

    return (
        <div className="absolute inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
            <div className="bg-white w-full sm:max-w-sm sm:rounded-lg rounded-t-2xl max-h-[85%] flex flex-col"
                 onClick={(e) => e.stopPropagation()}>
                <div className="px-4 py-3 border-b flex items-center justify-between">
                    <span className="font-semibold truncate">👥 {groupName}</span>
                    <button onClick={onClose} aria-label={t("chat.back")} className="text-xl text-gray-500">✕</button>
                </div>

                <div className="p-3 overflow-y-auto flex-1">
                    <div className="text-xs text-gray-500 mb-2">{t("group.membersCount", {n: memberIds.length})}</div>
                    {memberIds.map((id) => (
                        <div key={id} className="py-2 flex items-center gap-3">
                            <span className="relative">
                                <span className="w-8 h-8 rounded-full bg-teal-950 text-white text-xs flex items-center justify-center">
                                    {(nameOf(id)[0] ?? "?").toUpperCase()}
                                </span>
                                <span className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border border-white ${presence[id]?.online ? "bg-green-500" : "bg-gray-400"}`}/>
                            </span>
                            <span className="truncate text-sm text-gray-800">{nameOf(id)}</span>
                        </div>
                    ))}

                    {/* Add member */}
                    {/* text-base (16px): a smaller font makes mobile browsers auto-zoom on focus, which
                        blew the roster dialog off-screen ("приходится уменьшать вручную"). */}
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={t("group.addMember")}
                        className="mt-3 w-full rounded-full px-4 py-2 bg-gray-100 border focus:outline-none text-base"
                    />
                    {visible.map((u) => (
                        <button key={u.id} onClick={() => add(u)} disabled={adding}
                                className="w-full text-left py-2 flex items-center gap-3 hover:bg-gray-50 disabled:opacity-50">
                            <span className="w-8 h-8 rounded-full bg-teal-700 text-white text-xs flex items-center justify-center">＋</span>
                            <span className="truncate text-sm">{idsDisplayName(u)}</span>
                        </button>
                    ))}
                </div>

                <div className="p-3 border-t">
                    <button onClick={leave} disabled={leaving}
                            className="w-full text-red-600 border border-red-200 rounded-full py-2 text-sm font-medium hover:bg-red-50 disabled:opacity-50">
                        {t("group.leave")}
                    </button>
                </div>
            </div>
        </div>
    );
}
