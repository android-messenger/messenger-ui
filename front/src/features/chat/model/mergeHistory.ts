import type {ChatMessage} from "./schema/domainChatMessage.schema";
import {sameMessage} from "./historyCache";
import {isUlid} from "@/shared/ulid/ulid";

// Spec 003, story 2 — the ONE rule by which an answer of the history is put together with what the chat
// already holds. The answer never REPLACES the chat: it replaces only what it speaks about.
//
// What the answer speaks about is a range: from its first row to the moment the server read its table.
// Inside that range the server is right — a row it did not give is gone (deleted, or the chat was
// cleared). Outside it the chat keeps what it has:
//   - rows OLDER than the first row of the answer: pages loaded by "show earlier" (FR-016) — unless the
//     answer is the chat's whole history, then nothing older exists;
//   - rows that came over the socket AFTER the request was sent: the server read its table before it
//     took them, and it has been told they arrived, so it will never send them again (FR-011);
//   - my own messages that are still to be sent (FR-015).
// One message is one row, whatever ids it goes under (FR-034); the row of the answer wins and brings the
// server's time (FR-018), and keeps the text this device has decrypted (FR-019).

export interface MergeInput {
    /** What the chat holds now. */
    current: readonly ChatMessage[];
    /** The page the server gave: oldest first, one row per message. */
    answer: readonly ChatMessage[];
    /** The answer is the chat's whole history: it had fewer rows than a full page. */
    whole: boolean;
    /** Ids of the rows that came over the socket after the request was sent. */
    arrived: ReadonlySet<string>;
}

/** A row that exists only on this device: my message that the server has not confirmed. */
function unsent(m: ChatMessage): boolean {
    return m.status !== "sent";
}

/** True if `m` is older than `first`, the first row of the answer. Server ids (ULID) order by time. */
function olderThan(m: ChatMessage, first: ChatMessage): boolean {
    if (isUlid(m.id) && isUlid(first.id)) return m.id.toUpperCase() < first.id.toUpperCase();
    return m.createdAt.getTime() < first.createdAt.getTime();
}

/** The row of the answer, with what only this device knows about the message. */
function withLocal(fromServer: ChatMessage, local: ChatMessage | undefined): ChatMessage {
    if (!local) return fromServer;
    const row: ChatMessage = {...fromServer};
    if (!row.clientId && local.clientId) row.clientId = local.clientId;
    // a secret message: the server has the envelope, this device has the text
    if (local.secret) {
        row.text = local.text;
        row.secret = true;
        if (local.unsaved) row.unsaved = true;
    }
    return row;
}

/** The chat after the answer: oldest first. Does not change its arguments. */
export function mergeHistory({current, answer, whole, arrived}: MergeInput): ChatMessage[] {
    const page: ChatMessage[] = [];
    for (const row of answer) {
        if (!page.some((p) => sameMessage(p, row))) page.push(withLocal(row, current.find((c) => sameMessage(c, row))));
    }
    const inPage = (m: ChatMessage) => page.some((p) => sameMessage(p, m));
    const first = page[0];

    const older: ChatMessage[] = [];
    const newer: ChatMessage[] = [];
    for (const m of current) {
        if (inPage(m)) continue;
        if (unsent(m) || arrived.has(m.id)) newer.push(m);
        else if (!whole && first && olderThan(m, first)) older.push(m);
        // else: inside the range of the answer and not in it — gone on the server
    }
    newer.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return [...older, ...page, ...newer];
}
