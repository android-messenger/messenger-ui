import {useEffect, useState} from "react";
import {useNavigate} from "react-router-dom";
import {useDispatch, useSelector} from "react-redux";

import type {AppDispatch, RootState} from "@/store/store.ts";
import {chatApi, useCreateChatMutation} from "@/features/chat/rest/chatApi.ts";
import {setSelectedChatId} from "@/features/chat/model/slices/chatUiSlice.ts";
import {
    idsDisplayName,
    RefinementBar,
    useLazySearchIdsUsersQuery,
    type IdsConstraint,
    type IdsRefinement,
    type IdsUser,
} from "@/features/directory";
import {isNotLogged} from "@/shared/utils/checks.ts";
import {resolveChatPair} from "@/features/contacts/model/resolveChatPair.ts";
import {logger} from "@/shared/logger/logger.ts";
import toast from "react-hot-toast";
import {useTranslation} from "react-i18next";

function initials(name: string): string {
    const p = name.trim().split(/\s+/).filter(Boolean);
    return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
}

// Pick ONE person to chat with. The conversation is created between the current user and the
// picked one (pair ordered by id, see resolveChatPair). The backend lets a signed-in user create a
// chat only as one of the pair (no admin key in the client).
export default function AddContactPage() {
    const {t} = useTranslation();
    const myId = useSelector((s: RootState) => s.user.id);
    const dispatch = useDispatch<AppDispatch>();
    const [createChat, {isLoading: creating}] = useCreateChatMutation();
    const navigate = useNavigate();

    // The caller's conversations — to reuse an existing chat with a counterpart instead of minting
    // a second one (see startChat). Shares the cache with the chat list (RTK Query dedups).
    const {data: existingChats} = chatApi.useGetChatsQuery({myId}, {skip: isNotLogged(myId)});

    // Debounced, server-side, paginated adaptive search (IDS POST /people/search) — no
    // full directory download, no client-side filtering.
    // Aligned with the server's SEARCH_MIN_QUERY_LEN (3): the list AND the
    // adaptive clusters both start at 3 chars, so behaviour is consistent.
    const MIN_CHARS = 3;
    const [query, setQuery] = useState("");
    const [debounced, setDebounced] = useState("");
    const [items, setItems] = useState<IdsUser[]>([]);
    const [nextToken, setNextToken] = useState<string | undefined>(undefined);
    // Adaptive search: applied breadcrumb constraints + the server's suggested
    // next refinement (docs/adaptive-search). Picking one ANDs a constraint and
    // re-runs the search, narrowing the list.
    const [constraints, setConstraints] = useState<IdsConstraint[]>([]);
    const [refinement, setRefinement] = useState<IdsRefinement | undefined>(undefined);
    const constraintsKey = JSON.stringify(constraints);
    const [runSearch, {isFetching, isError}] = useLazySearchIdsUsersQuery();

    useEffect(() => {
        const t = setTimeout(() => {
            const q = query.trim();
            setDebounced(q);
            if (q.length < MIN_CHARS) setRefinement(undefined);   // too short → no suggestion either
        }, 300);
        return () => clearTimeout(t);
    }, [query]);

    useEffect(() => {
        if (debounced.length < MIN_CHARS) return; // too short → show nothing (derived below), don't fetch
        let cancelled = false;
        runSearch({q: debounced, constraints})
            .unwrap()
            .then((page) => {
                if (cancelled) return;
                setItems(page.users.filter((u) => u.id !== myId));
                setNextToken(page.nextToken);
                setRefinement(page.refinement);
            })
            .catch(() => { /* isError surfaces it */ });
        return () => { cancelled = true; };
        // constraints tracked via constraintsKey (stable string) to re-search on change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debounced, myId, runSearch, constraintsKey]);

    // Apply a refinement value as a breadcrumb (replacing any prior value for the
    // same discriminator); remove drops it. Both re-run the search via the effect.
    function applyConstraint(c: IdsConstraint) {
        setRefinement(undefined); // avoid a flash of the old suggestion before the re-search
        setConstraints((prev) => [...prev.filter((x) => x.field !== c.field), c]);
    }
    function removeConstraint(field: string) {
        setConstraints((prev) => prev.filter((x) => x.field !== field));
    }

    // Short query → show nothing (derived, so the effect never has to synchronously clear state on a
    // keystroke). Stale results from a prior longer query stay in `items` but are hidden until the next
    // search overwrites them.
    const showResults = debounced.length >= MIN_CHARS;
    const visibleItems = showResults ? items : [];
    const visibleNextToken = showResults ? nextToken : undefined;

    async function loadMore() {
        if (!nextToken) return;
        try {
            const page = await runSearch({q: debounced, pageToken: nextToken, constraints}).unwrap();
            setItems((prev) => [...prev, ...page.users.filter((u) => u.id !== myId)]);
            setNextToken(page.nextToken);
        } catch { /* keep current items */ }
    }

    async function startChat(other: IdsUser) {
        // Reuse an existing conversation with this counterpart if one is already in the list, in
        // EITHER role direction — don't mint a second one. This is what caused "two same-named chats":
        // a conversation is keyed by the ordered (clientId, masterId) tuple, so creating from the
        // opposite side (e.g. after the peer deleted it and the other party starts anew) with swapped
        // roles produced a distinct conversation for the same two people. Opening the existing one
        // (getChats maps counterpartId regardless of role) avoids the duplicate.
        const existing = existingChats?.find((s) => s.counterpartId === other.id);
        if (existing) {
            dispatch(setSelectedChatId(existing.conversationId));
            navigate("/");
            return;
        }

        // Deterministic (clientId, masterId) so a create from either side yields the same tuple and
        // createChat stays idempotent (no swapped-role duplicate). See resolveChatPair.
        const {clientId, masterId} = resolveChatPair(myId, other.id);
        try {
            const conv = await createChat({clientId, masterId, metadata: {}}).unwrap();
            // The pair may already exist and be soft-deleted for both sides (getChats hides it
            // until new activity revives it). Inject it into the list cache and open it directly,
            // so the user can send the first message — which revives the thread for both.
            const counterpartId = conv.clientId === myId ? conv.masterId : conv.clientId;
            dispatch(
                chatApi.util.updateQueryData("getChats", {myId}, (draft) => {
                    if (draft && !draft.some((s) => s.conversationId === conv.id)) {
                        draft.push({
                            conversationId: conv.id,
                            kind: "direct",
                            counterpartId,
                            orderId: conv.metadata?.orderId,
                            blocked: false,
                            blockedByMe: false,
                            blockedByPeer: false,
                        });
                    }
                })
            );
            dispatch(setSelectedChatId(conv.id));
            toast.success(t("addUser.chatOpened"));
            navigate("/");
        } catch (err) {
            const status = (err as {status?: number})?.status;
            logger.error("createChat failed", {status, err});
            toast.error(
                status === 409 ? t("addUser.createBlocked")
                    : status === 403 ? t("addUser.createForbidden")
                        : status === 400 ? t("addUser.createInvalid")
                            : t("addUser.createError")
            );
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-200/80 backdrop-blur-sm safe-area-pad-4">
            <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-6 flex flex-col gap-4">
                <h2 className="text-xl font-semibold text-center">{t("addUser.title")}</h2>

                <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("addUser.searchPlaceholder")}
                    className="w-full border border-gray-300 rounded-lg px-4 py-2
                    focus:outline-none focus:ring-2 focus:ring-teal-600"
                    autoFocus
                />

                {showResults && (
                    <RefinementBar
                        constraints={constraints}
                        refinement={refinement}
                        onApply={applyConstraint}
                        onRemove={removeConstraint}
                    />
                )}

                <div className="max-h-80 overflow-y-auto flex flex-col gap-1.5">
                    {debounced.length < MIN_CHARS && (
                        <p className="text-sm text-gray-500 text-center py-4">{t("addUser.minChars", {n: MIN_CHARS})}</p>
                    )}
                    {debounced.length >= MIN_CHARS && isError && (
                        <p className="text-sm text-red-600 text-center py-4">{t("addUser.searchError")}</p>
                    )}
                    {showResults && !isError && !isFetching && visibleItems.length === 0 && (
                        <p className="text-sm text-gray-500 text-center py-4">{t("addUser.noResults")}</p>
                    )}
                    {visibleItems.map((u) => {
                        const name = idsDisplayName(u);
                        return (
                            <button
                                key={u.id}
                                onClick={() => startChat(u)}
                                disabled={creating}
                                className="flex items-center gap-3 border rounded-lg px-3 py-2
                                text-left hover:bg-gray-50 disabled:opacity-50"
                            >
                                <span className="w-9 h-9 rounded-full bg-teal-950 text-white text-sm
                                flex items-center justify-center shrink-0">{initials(name)}</span>
                                <span className="flex flex-col min-w-0 flex-1">
                                    <span className="font-medium truncate">
                                        {name}
                                    </span>
                                    {u.email && <span className="text-xs text-gray-500 truncate">{u.email}</span>}
                                </span>
                            </button>
                        );
                    })}
                    {isFetching && <p className="text-sm text-gray-500 text-center py-2">{t("addUser.searching")}</p>}
                    {visibleNextToken && !isFetching && (
                        <button
                            type="button"
                            onClick={loadMore}
                            className="text-sm text-teal-800 hover:underline py-2"
                        >
                            {t("addUser.showMore")}
                        </button>
                    )}
                </div>

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
