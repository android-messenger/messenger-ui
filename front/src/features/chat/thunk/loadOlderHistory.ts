import type {AppDispatch, RootState} from "@/store/store";
import {chatApi} from "@/features/chat/rest/chatApi";
import {MESSENGER_API} from "@/shared/config/api";
import {HISTORY_PAGE_SIZE} from "@/shared/config/chat";
import {toMessages} from "@/features/chat/model/reconcileHistory";
import {hasMessage} from "@/features/chat/model/historyCache";
import {isUlid} from "@/shared/ulid/ulid";
import {logger} from "@/shared/logger/logger";

/**
 * Pull the page of history immediately older than what's loaded (`?before=<oldest ULID>`) and
 * PREPEND it into the getChatHistory cache. Returns the count of NEW messages added — 0 means we
 * reached the start (or nothing more), so the caller can stop offering "show earlier".
 *
 * `before` must be a real server ULID; our own not-yet-reconciled temp client ids can't be a cursor,
 * so we pick the oldest loaded message that IS a ULID.
 */
export function loadOlderHistory(chatId: string) {
    return async (dispatch: AppDispatch, getState: () => RootState): Promise<number> => {
        const myId = (getState().user?.id as string) || "";
        if (!myId || !chatId) return 0;
        const data = chatApi.endpoints.getChatHistory.select({myId, chatId})(getState())?.data;
        if (!data || data.length === 0) return 0;

        const before = data.find((m) => isUlid(m.id))?.id;
        if (!before) return 0;

        let rows;
        try {
            const q = new URLSearchParams({limit: String(HISTORY_PAGE_SIZE), before});
            const res = await fetch(`${MESSENGER_API}/chats/${chatId}/messages?${q.toString()}`, {
                credentials: "include",
            });
            if (!res.ok) return 0;
            rows = toMessages(await res.json());
        } catch (e) {
            logger.error("loadOlderHistory failed", e as Error);
            return 0;
        }
        if (!rows.length) return 0;

        let added = 0;
        dispatch(
            chatApi.util.updateQueryData("getChatHistory", {myId, chatId}, (draft) => {
                // Canonical id||clientId dedup (model/historyCache); rows are ASC and older than draft[0],
                // so PREPEND to keep the array chronological (loadOlderHistory's cursor reads draft order).
                const fresh = rows.filter((m) => !hasMessage(draft, m));
                added = fresh.length;
                if (fresh.length) draft.unshift(...fresh);
            })
        );
        return added;
    };
}
