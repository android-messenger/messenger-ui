import type {Action, Middleware, PayloadAction} from "@reduxjs/toolkit";
import {
    connected,
    connecting,
    disconnected,
    superseded,
    error as wsError,
    incoming,
    outgoing,
} from "@/infrastructure/slices/websocketSlice.ts";

import {DELAY_STEP_MS, MAX_RECONNECT_DELAY} from "@/shared/config/ws";
import {recordConnect} from "@/shared/diag/diag.ts";
import type {OutgoingWSMessage, WSMessage} from "../types.ts";
import {fromWire, toWire} from "@/infrastructure/ws/frameBridge.ts";
import {isNotLogged} from "@/shared/utils/checks";
import {logger} from "@/shared/logger/logger.ts";
import type {RootState} from "@/store/store.ts";
import {isAppBackgrounded} from "@/infrastructure/native/appLifecycle.ts";

// Feature-owned bits are INJECTED from the composition root (store.ts) so this transport layer stays
// feature-agnostic (it must not import UP into features/auth or features/chat):
//  - probeSession: resolve if the Kratos session is still valid, reject (with a `.response.status`) if not
//  - clearUser: the action to dispatch when the session is gone → re-auth
//  - callConversationId: resolve a call frame's conversationId from the chat directory by counterpart id
export type WebsocketDeps = {
    probeSession: () => Promise<unknown>;
    clearUser: () => Action;
    callConversationId: (state: unknown, toUserId: string) => string | undefined;
};


type WSConnectAction = PayloadAction<{ url: string }, string, { shouldReconnect: boolean; }>
type WSDisconnectAction = PayloadAction<unknown>;
type WSSendAction = PayloadAction<OutgoingWSMessage>;
type WSActions = PayloadAction<OutgoingWSMessage> | WSDisconnectAction | WSSendAction;

// --------------------
// Runtime state middleware
// --------------------

let socket: WebSocket | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;

// --- Reconnect circuit breaker (stops the connect↔reconnect ping-pong) ---
// The backend enforces ONE active session per user: opening a 2nd session (another tab/device)
// makes it CLOSE the older socket (a clean 1000, indistinguishable from a normal close). Since we
// reconnect on every close, two live sessions of one user would evict each other forever. This
// breaker detects the signature — a socket that OPENS then closes again almost immediately, several
// times in a row — and backs off hard (a cooldown) instead of hammering. A durable connection
// (alive past RAPID_CLOSE_MS) clears it, so a normal single reconnect never trips it.
const RAPID_CLOSE_MS = 10_000;      // a close within this of opening = a "rejected"/evicted cycle
const RAPID_CYCLE_LIMIT = 3;        // this many rapid cycles in a row → trip the breaker
const CIRCUIT_COOLDOWN_MS = 60_000; // then attempt at most once per this window
// Backend close code for a session TAKE-OVER (a newer session for the same user superseded this one).
// A WS application close code (3000–4999) the browser exposes in CloseEvent.code. See the backend spec.
const WS_SUPERSEDED_CODE = 4409;
let openedAt = 0;                   // when the current socket's onopen fired (0 = never opened)
let rapidCycles = 0;                // consecutive open→quick-close cycles
let cooldownUntil = 0;              // epoch ms until which reconnects are held off
let stableTimer: ReturnType<typeof setTimeout> | null = null; // fires once a connection proves durable

// --------------------
// Middleware
// --------------------

export const createWebsocketMiddleware = (deps: WebsocketDeps): Middleware =>
    (store) => (next) => (action) => {
        const { dispatch } = store;

        const scheduleReconnect = (url: string) => {
            reconnectAttempts += 1;

            const backoff = Math.min(
                DELAY_STEP_MS * 2 ** reconnectAttempts,
                MAX_RECONNECT_DELAY
            );
            // ±20% jitter: a backend restart drops every client at once and a fixed backoff would make
            // them all retry in lockstep (thundering herd). Spreading each client's delay randomly
            // decorrelates the reconnect wave.
            const jittered = backoff * (0.8 + Math.random() * 0.4);
            // Honor an active circuit-breaker cooldown: never attempt sooner than cooldownUntil.
            const delay = Math.max(jittered, cooldownUntil - Date.now());

            logger.debug(`🔁 WS reconnect #${reconnectAttempts} in ${delay}ms`);
            reconnectTimeout = setTimeout(() => {
                reconnectTimeout = null; // clear BEFORE connecting so the ref never goes stale
                connect(url, true);
            }, delay);
        };

        const connect = (url: string, shouldReconnect: boolean) => {
            const state = store.getState() as RootState;
            const user = state.user;


            if (isNotLogged(user.id)) {
                logger.debug("WS connect skipped: user not logged in");
                return;
            }

            if (
                socket &&
                (socket.readyState === WebSocket.OPEN ||
                    socket.readyState === WebSocket.CONNECTING)
            ) {
                return;
            }

            dispatch(connecting());
            const thisSocket = new WebSocket(url);
            socket = thisSocket;

            thisSocket.onopen = () => {
                reconnectAttempts = 0;
                openedAt = Date.now();
                recordConnect();   // diagnostics: rolling (re)connect count
                // If this connection stays up past the rapid window, it's healthy → clear the breaker.
                if (stableTimer) clearTimeout(stableTimer);
                stableTimer = setTimeout(() => { rapidCycles = 0; }, RAPID_CLOSE_MS);
                dispatch(connected());
                logger.debug(`🔗 WS connected #${reconnectAttempts} to ${url}`);
            };

            thisSocket.onmessage = (event: MessageEvent<string>) => {
                try {
                    const raw = JSON.parse(event.data) as WSMessage;
                    dispatch(incoming(fromWire(raw)));
                } catch {
                    dispatch(wsError("WS parse error"));
                }
            };

            thisSocket.onerror = () => {
                dispatch(wsError("WebSocket error"));
            };

            thisSocket.onclose = (event: CloseEvent) => {
                // Closure-race fix: only drop the module ref if it STILL points at THIS socket. A
                // late onclose of a superseded socket must not null a newer live one (that would let
                // the OPEN/CONNECTING guard pass and spawn a duplicate socket → self-eviction loop).
                if (socket === thisSocket) socket = null;
                if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
                dispatch(disconnected());

                if (!shouldReconnect) return;

                // Session TAKE-OVER (backend "single active session per user"): the server closes the
                // OLDER socket with 4409 when a NEW session for this user connects. Do NOT auto-reconnect
                // — that would resume the eviction ping-pong. This is the deterministic counterpart to
                // the circuit-breaker throttle: the loser yields cleanly. A user-driven ws/connect (this
                // tab regains focus → onWake) can still reconnect and take the session back.
                if (event.code === WS_SUPERSEDED_CODE) {
                    logger.debug("WS superseded (4409): another session took over — not auto-reconnecting");
                    dispatch(superseded());
                    return;
                }

                // Circuit breaker: a socket that OPENED then closed within RAPID_CLOSE_MS is the
                // eviction/rejection signature. Count consecutive such cycles; a slower close (or a
                // never-opened attempt) doesn't count. Past the limit, arm a cooldown that scheduleReconnect
                // folds into its delay (a THROTTLE — the auto-reconnect loop slows to ~once/cooldown
                // instead of ping-ponging). It never BLOCKS: a user-driven ws/connect (visibility/online
                // wake) still connects immediately, and the automatic reconnect is only slowed, not stopped.
                if (openedAt) {
                    if (Date.now() - openedAt < RAPID_CLOSE_MS) rapidCycles += 1;
                    else rapidCycles = 0;
                }
                openedAt = 0;
                if (rapidCycles >= RAPID_CYCLE_LIMIT) {
                    cooldownUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
                    rapidCycles = 0;
                    logger.debug(`⛔ WS reconnect throttled: ${RAPID_CYCLE_LIMIT} rapid cycles → cooldown ${CIRCUIT_COOLDOWN_MS}ms (another session may hold this user)`);
                }

                // A rejected WS upgrade (expired Kratos session) surfaces as a generic close (1006),
                // indistinguishable from a network drop — so blind reconnect would loop forever while
                // the user still looks "logged in" and is never sent to /login. After a few failures,
                // probe the session: if it's gone, stop the loop and trigger re-auth (clearUser makes
                // RequireAuth redirect and connect() then skips as not-logged-in); if it's valid, it's
                // a genuine network issue → keep retrying.
                if (reconnectAttempts >= 3) {
                    deps.probeSession().then(
                        () => scheduleReconnect(url),
                        (err: unknown) => {
                            // Only treat a real 401/403 as "session gone → re-auth". A network
                            // failure/timeout ALSO rejects toSession() (no response), and that is the
                            // common case here (the same outage that dropped the WS) — logging the user
                            // out then would be a false logout on a valid session. Keep retrying instead.
                            const status = (err as {response?: {status?: number}})?.response?.status;
                            if (status === 401 || status === 403) {
                                logger.debug("WS reconnect halted: session invalid → re-auth");
                                dispatch(deps.clearUser());
                                dispatch({type: "ws/disconnect"});
                            } else {
                                logger.debug("WS session probe inconclusive (network) → keep retrying");
                                scheduleReconnect(url);
                            }
                        }
                    );
                    return;
                }
                scheduleReconnect(url);
            };
        };

        // --------------------
        // Action handling
        // --------------------

        const wsAction = action as WSActions;

        switch (wsAction.type) {
            case "ws/connect": {
                // Android app in the background (S1 §7.0): no connection until appForeground.
                if (isAppBackgrounded()) {
                    logger.debug("WS connect skipped: app in background");
                    break;
                }
                logger.debug("connecting by action ", wsAction.type);

                const { url } = (action as WSConnectAction).payload;
                const shouldReconnect = Boolean(
                    (action as WSConnectAction).meta?.shouldReconnect
                );

                if (reconnectTimeout) {
                    clearTimeout(reconnectTimeout);
                    reconnectTimeout = null;
                }

                reconnectAttempts = 0;
                connect(url, shouldReconnect);
                break;
            }

            case "ws/disconnect": {
                logger.debug("disconnected ws by action");
                if (reconnectTimeout) {
                    clearTimeout(reconnectTimeout);
                    reconnectTimeout = null;
                }

                reconnectAttempts = 0;
                // Reset the circuit breaker: an explicit disconnect (logout / re-auth) is a clean
                // slate — the next connect must not be held off by a stale cooldown.
                if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
                openedAt = 0;
                rapidCycles = 0;
                cooldownUntil = 0;

                if (socket) {
                    // Detach the reconnecting handlers FIRST: an explicit disconnect must NOT trigger
                    // the onclose auto-reconnect (its closure captured shouldReconnect=true). Without
                    // this, ws/disconnect would immediately reconnect — defeating a deliberate go
                    // offline (logout, or the page-suspend disconnect that lets Web Push take over).
                    socket.onclose = null;
                    socket.onerror = null;
                    socket.close(1000, "Client disconnect");
                    socket = null;
                }

                dispatch(disconnected());
                break;
            }

            case "ws/send": {
                logger.debug("sending ws by action");

                if (socket?.readyState === WebSocket.OPEN) {
                    const payload = (action as WSSendAction).payload;
                    // For WebRTC call frames, resolve the conversationId from the chat directory
                    // by the counterpart user id (`to`), so the SIGNAL_IN passes backend validation.
                    let ctx: { conversationId?: string } | undefined;
                    const p = payload as { type?: string; to?: string };
                    if (typeof p.type === "string" && p.type.startsWith("call:") && p.to) {
                        ctx = {conversationId: deps.callConversationId(store.getState(), p.to)};
                    }
                    socket.send(JSON.stringify(toWire(payload, ctx)));
                    dispatch(outgoing(payload));
                }
                break;
            }
        }

        return next(action);
    };
