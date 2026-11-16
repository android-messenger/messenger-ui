import {type ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema.ts";
import {wireToChatMessage} from "@/features/chat/model/mapper.ts";
import {hasMessage} from "@/features/chat/model/historyCache.ts";
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
 * One row per message (sameMessage), the first seen kept — guarding against a duplicate the server
 * returns: a peer on an earlier build sends again, and every copy is stored under its own server id.
 */
export function dedupMessages(rows: ChatMessage[]): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const m of rows) if (!hasMessage(out, m)) out.push(m);
    return out;
}
