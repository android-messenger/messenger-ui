import type {AppDispatch, RootState} from "@/store/store";
import {olderTaken, selectRows} from "@/features/chat/model/slices/chatHistorySlice";
import {MESSENGER_API} from "@/shared/config/api";
import {HISTORY_PAGE_SIZE} from "@/shared/config/chat";
import {toMessages} from "@/features/chat/model/reconcileHistory";
import {hasMessage} from "@/features/chat/model/historyCache";
import {isUlid} from "@/shared/ulid/ulid";
import {logger} from "@/shared/logger/logger";

/**
 * Pull the page of history immediately older than what's loaded (`?before=<oldest ULID>`) and
 * PREPEND it to the chat's rows (the chatHistory slice). Returns the count of NEW messages added. That the
 * server has nothing older is written to the slice (`noOlder`); a request that failed says nothing about it.
 *
 * `before` must be a real server ULID; our own not-yet-reconciled temp client ids can't be a cursor,
 * so we pick the oldest loaded message that IS a ULID.
 */
export function loadOlderHistory(chatId: string) {
    return async (dispatch: AppDispatch, getState: () => RootState): Promise<number> => {
        if (!chatId) return 0;
        const data = selectRows(getState(), chatId);
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
        if (!rows.length) {
            dispatch(olderTaken({chatId, rows, noOlder: true}));
            return 0;
        }

        // Canonical id||clientId dedup (model/historyCache); the page is ASC and older than the first row,
        // so the slice PREPENDS it and the rows stay chronological (the cursor above reads their order).
        const now = selectRows(getState(), chatId);
        if (!now) return 0;
        const added = rows.filter((m) => !hasMessage(now, m)).length;
        dispatch(olderTaken({chatId, rows, noOlder: rows.length < HISTORY_PAGE_SIZE}));
        return added;
    };
}
