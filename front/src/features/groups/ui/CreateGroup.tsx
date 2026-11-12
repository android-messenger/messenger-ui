import {useEffect, useMemo, useState} from "react";
import {useNavigate} from "react-router-dom";
import {useDispatch, useSelector} from "react-redux";
import toast from "react-hot-toast";
import {useTranslation} from "react-i18next";

import type {AppDispatch, RootState} from "@/store/store.ts";
import {setSelectedChatId} from "@/features/chat/model/slices/chatUiSlice.ts";
import {idsDisplayName, useLazySearchIdsUsersQuery, type IdsUser} from "@/features/directory";
import {isNotLogged} from "@/shared/utils/checks.ts";
import {useCreateGroupMutation} from "../rest/groupApi.ts";

const initials = (name: string) => {
    const p = name.trim().split(/\s+/).filter(Boolean);
    return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
};

/**
 * Create a GROUP chat: name it and pick ≥1 member from the IDS directory (same debounced server-side
 * search as AddUser). POST /api/groups → the backend mints the group; we open it (createGroup
 * invalidates the chat list so the new group appears). 422 = too few members, 413 = over the size cap.
 */
export default function CreateGroup() {
    const {t} = useTranslation();
    const myId = useSelector((s: RootState) => s.user.id);
    const dispatch = useDispatch<AppDispatch>();
    const navigate = useNavigate();
    const [createGroup, {isLoading: creating}] = useCreateGroupMutation();

    const [name, setName] = useState("");
    const [query, setQuery] = useState("");
    const [debounced, setDebounced] = useState("");
    const [items, setItems] = useState<IdsUser[]>([]);
    const [selected, setSelected] = useState<Record<string, IdsUser>>({});
    const [runSearch, {isFetching, isError}] = useLazySearchIdsUsersQuery();

    const MIN_CHARS = 2;
    useEffect(() => {
        const h = setTimeout(() => setDebounced(query.trim()), 300);
        return () => clearTimeout(h);
    }, [query]);

    useEffect(() => {
        if (debounced.length < MIN_CHARS) return;   // too short → the render gates the list to []
        let cancelled = false;
        runSearch({q: debounced}).unwrap()
            .then((page) => { if (!cancelled) setItems(page.users.filter((u) => u.id !== myId)); })
            .catch(() => { /* isError surfaces it */ });
        return () => { cancelled = true; };
    }, [debounced, myId, runSearch]);

    const selectedList = useMemo(() => Object.values(selected), [selected]);
    const visible = debounced.length < MIN_CHARS ? [] : items;

    const toggle = (u: IdsUser) => setSelected((prev) => {
        const next = {...prev};
        if (next[u.id]) delete next[u.id]; else next[u.id] = u;
        return next;
    });

    async function create() {
        if (selectedList.length < 1 || creating) return;
        try {
            const group = await createGroup({
                memberIds: selectedList.map((u) => u.id),
                name: name.trim() || undefined,
            }).unwrap();
            dispatch(setSelectedChatId(group.id));
            navigate("/");
        } catch (e) {
            const status = (e as {status?: number})?.status;
            toast.error(
                status === 413 ? t("group.tooManyMembers")
                    : status === 422 ? t("group.tooFewMembers")
                    : t("group.createError"),
            );
        }
    }

    if (isNotLogged(myId)) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-200/80 backdrop-blur-sm safe-area-pad-4">
            <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-6 flex flex-col gap-4">
                <h2 className="text-xl font-semibold text-center">{t("group.newGroup")}</h2>

                <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t("group.namePlaceholder")}
                    className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-teal-600"
                    autoFocus
                />

                {/* Selected chips */}
                {selectedList.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                        {selectedList.map((u) => (
                            <button key={u.id} onClick={() => toggle(u)}
                                    className="flex items-center gap-1 bg-teal-100 text-teal-900 rounded-full pl-3 pr-2 py-1 text-sm">
                                {idsDisplayName(u)} <span className="opacity-60">✕</span>
                            </button>
                        ))}
                    </div>
                )}

                <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("group.searchMembers")}
                    className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-teal-600"
                />

                <div className="max-h-72 overflow-y-auto flex flex-col gap-1.5">
                    {debounced.length < MIN_CHARS && (
                        <p className="text-sm text-gray-500 text-center py-4">{t("addUser.minChars", {n: MIN_CHARS})}</p>
                    )}
                    {debounced.length >= MIN_CHARS && isError && (
                        <p className="text-sm text-red-600 text-center py-4">{t("addUser.searchError")}</p>
                    )}
                    {debounced.length >= MIN_CHARS && !isError && !isFetching && visible.length === 0 && (
                        <p className="text-sm text-gray-500 text-center py-4">{t("addUser.noResults")}</p>
                    )}
                    {visible.map((u) => {
                        const dn = idsDisplayName(u);
                        const picked = !!selected[u.id];
                        return (
                            <button
                                key={u.id}
                                onClick={() => toggle(u)}
                                className={`flex items-center gap-3 border rounded-lg px-3 py-2 text-left hover:bg-gray-50
                                ${picked ? "bg-teal-50 border-teal-300" : ""}`}
                            >
                                <span className="w-9 h-9 rounded-full bg-teal-950 text-white text-sm flex items-center justify-center shrink-0">
                                    {initials(dn)}
                                </span>
                                <span className="flex flex-col min-w-0 flex-1">
                                    <span className="font-medium truncate">{dn}</span>
                                    {u.email && <span className="text-xs text-gray-500 truncate">{u.email}</span>}
                                </span>
                                <span className={`w-5 h-5 rounded-full border flex items-center justify-center text-xs shrink-0
                                ${picked ? "bg-teal-700 text-white border-teal-700" : "border-gray-400"}`}>
                                    {picked ? "✓" : ""}
                                </span>
                            </button>
                        );
                    })}
                    {isFetching && <p className="text-sm text-gray-500 text-center py-2">{t("addUser.searching")}</p>}
                </div>

                <button
                    onClick={create}
                    disabled={selectedList.length < 1 || creating}
                    className="w-full bg-teal-950 text-white py-2 rounded-lg font-medium hover:bg-teal-900 transition disabled:opacity-50"
                >
                    {creating ? t("loading") : t("group.create", {n: selectedList.length})}
                </button>
                <button
                    onClick={() => navigate(-1)}
                    className="w-full border border-gray-300 py-2 rounded-lg hover:bg-gray-100 transition"
                >
                    {t("addUser.cancel")}
                </button>
            </div>
        </div>
    );
}
