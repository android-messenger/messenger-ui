// Peers whose key changed and whose user has not closed the notice yet (spec 001, FR-054). A mirror, in
// memory, of what the app's library keeps durably: the library holds the mark until the user closes the
// line in the chat or compares the safety number again (audit 2026-11-12, finding 2: the mark used to be
// taken off by the first read, and a reload before the chat was opened lost it).

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
