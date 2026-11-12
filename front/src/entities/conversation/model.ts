// The Conversation entity: the frontend chat-list item, derived from the backend Conversation
// relative to the caller. Shared across features (chat, contacts, call, the WS transport), so it
// lives in the entities layer rather than inside any one feature's api.

/** DIRECT = 1:1 (client↔master pair); GROUP = N members (ADR-024), null pair, name in metadata. */
export type ChatKind = "direct" | "group";

/** Frontend chat-list item derived from a backend Conversation, relative to the caller. */
export type ChatSummary = {
    conversationId: string;
    kind: ChatKind;
    counterpartId: string;   // DIRECT: the peer's id. GROUP: "" — a group has no single counterpart.
    name?: string;           // GROUP: display name (from metadata.name). DIRECT: undefined (derived elsewhere).
    memberIds?: string[];    // GROUP: roster when known. The chat LIST carries none (loaded per-group on open).
    updatedAt?: number;      // epoch ms of last activity (from the backend) — the chat-list sort baseline.
    orderId?: string;
    blocked: boolean;        // DIRECT only (block is a mutual/terminal per-pair stop). GROUP: always false.
    blockedByMe: boolean;    // I blocked the peer (I can unblock)
    blockedByPeer: boolean;  // the peer blocked me (I can't unblock their side)
};
