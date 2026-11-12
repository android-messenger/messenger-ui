// S1 §7.0 (Android app only): the backend pushes only to users without a live WebSocket, so when the
// whole app goes to the background the native side sends `appBackground`; we close the WebSocket
// (the existing explicit ws/disconnect, which detaches auto-reconnect), keep every reconnect path
// off while backgrounded, and answer `wsClosed`. `appForeground` lifts the suppression and
// reconnects; useReconnectCatchup loads what was missed. Never imported in the browser build path.

let backgrounded = false;

/** True while the Android app is in the background (reconnects must not run). Always false in a browser. */
export function isAppBackgrounded(): boolean {
    return backgrounded;
}

export function setAppBackgrounded(v: boolean): void {
    backgrounded = v;
}
