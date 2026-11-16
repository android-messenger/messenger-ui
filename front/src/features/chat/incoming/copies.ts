// A peer on an earlier build sends an unconfirmed message again and again, and the server stores every
// frame as a message of its own: the same client id under another server id. It is one row (historyCache)
// and one notification: a copy is acknowledged and told to the app, and nothing more.
//
// The client ids of the messages that came over the socket, with the server id each came under first —
// kept for this start of the application, the last SEEN_MAX of them. Not in the store: it says nothing
// about the session, and a copy is a copy whoever is signed in.

const SEEN_MAX = 500;
const seen = new Map<string, string>();

/** True if a message of this sender with this client id has already come under ANOTHER server id. The same
 * server id again is the same delivery repeated (its acknowledgement was lost), not a copy. */
export function isCopy(senderId: string | undefined, clientId: string | undefined, serverId: string): boolean {
    if (!senderId || !clientId) return false;
    const key = `${senderId}|${clientId}`;
    const first = seen.get(key);
    if (first !== undefined) return first !== serverId;
    seen.set(key, serverId);
    if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value as string);
    return false;
}
