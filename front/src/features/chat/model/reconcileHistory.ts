import {type ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema.ts";
import {wireToChatMessage} from "@/features/chat/model/mapper.ts";
import {parseWireMessage} from "@/features/chat/model/schema/wireMessage.schema.ts";

// Pure history-reconciliation helpers, extracted from the RTK Query api (chatApi) so the parsing +
// dedup rules are unit-testable in isolation and the api file stays about data fetching.

/**
 * Wire rows (a history page) → domain messages. The history endpoint returns either the newer
 * envelope `{ messages: [...] }` or a bare array (legacy) — both are accepted. Unparseable rows are
 * dropped. No dedup here (see dedupMessages).
 */
export function toMessages(raw: unknown): ChatMessage[] {
    const arr = Array.isArray(raw)
        ? raw
        : (raw && typeof raw === "object" && Array.isArray((raw as { messages?: unknown }).messages)
            ? (raw as { messages: unknown[] }).messages
            : []);
    return arr
        .map(parseWireMessage)
        .filter((m): m is NonNullable<typeof m> => Boolean(m))
        .map(wireToChatMessage);
}

/**
 * Dedup by clientId||id, guarding against any duplicate the server returns. History rows normally
 * carry no clientId; when they do, an echo and its server row collapse to the first seen. Both the
 * dedup key AND the raw id are tracked so a later row matching either is dropped.
 */
export function dedupMessages(rows: ChatMessage[]): ChatMessage[] {
    const seen = new Set<string>();
    return rows.filter((m) => {
        const key = m.clientId || m.id;
        if (seen.has(key) || seen.has(m.id)) return false;
        seen.add(key);
        seen.add(m.id);
        return true;
    });
}
