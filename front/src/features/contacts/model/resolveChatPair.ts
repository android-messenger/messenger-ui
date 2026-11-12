// Decide the (clientId, masterId) tuple for a conversation between the caller and a counterpart.
//
// A conversation is keyed server-side by the ORDERED (clientId, masterId) tuple, so both participants
// MUST arrive at the identical tuple regardless of who initiates — otherwise creating from opposite
// sides mints two conversations for the same two people ("two same-named chats"). The directory no
// longer exposes roles (gate audit SEC-08; they were empty for everyone anyway), so the tuple is a
// DETERMINISTIC id ordering — never "whoever initiated" — stable from either direction.
export function resolveChatPair(myId: string, otherId: string): { clientId: string; masterId: string } {
    const [clientId, masterId] = [myId, otherId].sort();
    return { clientId, masterId };
}
