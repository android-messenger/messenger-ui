// Peers whose key changed and whose user has not been told yet (spec 001, FR-054). Kept in memory: the
// app's library holds the mark durably and hands it over once, when the peer's state is read; from then
// on it lives here until the user dismisses the line in the chat.

const changed = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: readonly string[] = [];

function emit(): void {
    snapshot = [...changed];
    for (const l of listeners) { try { l(); } catch { /* a listener must not break a crypto call */ } }
}

export function noteKeyChanged(peerUserId: string): void {
    if (changed.has(peerUserId)) return;
    changed.add(peerUserId);
    emit();
}

export function dismissKeyChanged(peerUserId: string): void {
    if (changed.delete(peerUserId)) emit();
}

/** For useSyncExternalStore: the peers with an unseen key change. */
export function keyChangedPeers(): readonly string[] { return snapshot; }

export function onKeyChanged(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Logout: nothing about the previous user's peers stays in memory. */
export function forgetKeyChanges(): void {
    if (!changed.size) return;
    changed.clear();
    emit();
}
