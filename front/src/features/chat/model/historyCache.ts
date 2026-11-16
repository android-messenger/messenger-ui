import type {ChatMessage} from "./schema/domainChatMessage.schema";

/** What tells one message from another: its server id and the sender's client id (spec 003, FR-050). */
export type MessageRef = Pick<ChatMessage, "id"> & {clientId?: string};

/**
 * The ONE canonical identity + insert rule for the rows of a chat (the chatHistory slice). Every writer (live
 * CHAT_OUT append, optimistic-echo enqueue, older-page prepend) must dedup through here so the rule
 * can't drift (it previously diverged: id-only vs id-or-clientId across the writers).
 *
 * The only place that says two messages are one: the history slice, the merge of an answer, a page of
 * the server (dedupMessages), deleting a row — all call it (spec 003, scenario 6.1).
 *
 * Two rows are the SAME message if their server ids match, OR either side's stable `clientId` (the
 * sender's original messageId, echoed by the backend as `correlationId`) matches the other's id or
 * clientId. That collapses an optimistic echo (id=clientId), its live delivery (clientId=correlationId),
 * and its reconciled server row (id=ULID, clientId=correlationId) into a single row. ids and clientIds
 * are unique per message, so this never falsely merges two distinct messages.
 */
export function sameMessage(a: MessageRef, b: MessageRef): boolean {
    if (a.id === b.id) return true;
    const ac = a.clientId, bc = b.clientId;
    if (ac && (ac === bc || ac === b.id)) return true;
    if (bc && bc === a.id) return true;
    return false;
}

/** True if an equivalent message is already in the list. */
export function hasMessage(list: readonly MessageRef[], msg: MessageRef): boolean {
    return list.some((m) => sameMessage(m, msg));
}

/**
 * Append `msg` to a history draft unless an equivalent one is already present. Ordering is not this
 * helper's concern — the view (useChatMessages) re-sorts by createdAt, so appending is safe.
 */
export function upsertMessage(draft: ChatMessage[], msg: ChatMessage): void {
    if (!hasMessage(draft, msg)) draft.push(msg);
}
