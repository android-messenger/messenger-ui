// Spec 002 §3.1 — the sign that the socket had a gap.
//
// The history is the source of truth; the socket only makes it faster. What a chat shows counts as
// complete only while the client can prove it: its history was READ FROM THE SERVER during the current
// connection of the socket (ws.epoch), and the request started while the socket was already connected —
// so everything stored before the request is in the answer and everything after it comes over the socket.
//
// Any gap — the app in the background, a network drop, another session taking over, the server closing
// the socket, a page reload — gives a new connection number, so every chat is stale at once, whatever the
// reason. A stale chat is read again: the open one right after the connection, the others when opened.
// A chat that is not stale is not read again.

type WsView = {status?: string; epoch?: number} | undefined;

/** chatId → the connection number its history was last read under. Memory only: a reload starts empty. */
const synced = new Map<string, number>();

/** The connection number if the socket is connected now, else null (nothing read now can be proved complete). */
export function liveEpoch(ws: WsView): number | null {
    return ws?.status === "connected" && typeof ws.epoch === "number" ? ws.epoch : null;
}

/** A read of the chat's history that STARTED under `startedUnder` has ended well. True if it proves the chat complete. */
export function noteHistoryRead(chatId: string, startedUnder: number | null, ws: WsView): boolean {
    const now = liveEpoch(ws);
    if (startedUnder === null || now !== startedUnder) return false;   // the socket was down, or changed meanwhile
    synced.set(chatId, startedUnder);
    return true;
}

/** True if the chat's history cannot be proved complete: read under another connection, or never. */
export function isStale(chatId: string, ws: WsView): boolean {
    const now = liveEpoch(ws);
    return now === null || synced.get(chatId) !== now;
}

/** The chat got something outside the socket (a push, a notification tap): read it again. */
export function markStale(chatId: string): void {
    synced.delete(chatId);
}

/** Sign-out, tests. */
export function forgetHistorySync(): void {
    synced.clear();
}
