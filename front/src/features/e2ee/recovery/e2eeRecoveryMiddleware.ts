import type {Middleware} from "@reduxjs/toolkit";
import {chatApi} from "@/features/chat/rest/chatApi.ts";
import {logger} from "@/shared/logger/logger.ts";
import i18n from "@/shared/i18n";
import {savePlaintext} from "../lib/atRest.ts";
import {secretStateKey} from "../lib/failure.ts";
import {addPending, allPending, bumpAttempt, removePending, type PendingItem} from "./pendingStore.ts";
import {RECOVER_REQ, RECOVER_RESP, buildRequest, buildResponse, applyResponse, type RecoverReq, type RecoverResp} from "./protocol.ts";
import {REKEY_HINT, makeThrottle, REKEY_COALESCE_MS} from "../lib/rekeyHint.ts";
import {invalidatePeer} from "../lib/secretSession.ts";
import {ensureProvisioned} from "../lib/provisioning.ts";
import {presenceJoin, type ClientData} from "@/features/presence/model/presenceSlice.ts";

// Coalesce inbound rekey hints: at most one roster re-resolve per peer per window (a spoofed/flooded hint
// then costs at most one bounded directory re-fetch).
const rekeyActThrottle = makeThrottle(REKEY_COALESCE_MS);

// Client-to-client recovery (Step B), as a SELF-CONTAINED module. When a secret message can't be decrypted
// (permanent gap / ciphertext the ratchet never saw), we ask the ORIGINAL sender to re-encrypt it from
// their own stored plaintext — recovering the message without recovering a key (forward secrecy intact).
// The chat pipeline stays clean: chatMiddleware only DISPATCHES `e2ee/reportUndecryptable`; every bit of
// protocol, retry and persistence lives here and in ./protocol + ./pendingStore.

export const REPORT_UNDECRYPTABLE = "e2ee/reportUndecryptable";
export interface ReportUndecryptable {
    type: typeof REPORT_UNDECRYPTABLE;
    payload: { chatId: string; peerId: string; items: Array<{clientId: string; serverId: string}> };
}
/** Dispatched by chatMiddleware when a history secret message fails to decrypt (has a clientId to correlate). */
export const reportUndecryptable = (payload: ReportUndecryptable["payload"]): ReportUndecryptable => ({type: REPORT_UNDECRYPTABLE, payload});

const RETRY_BASE_MS = 30_000;
const RETRY_FACTOR = 1.5;
// Cap the backoff at a minute. The request is a transient SIGNAL: the backend drops it while the sender is
// absent (an Android app closes its WebSocket in the background), so a retry only lands while both sides are
// connected — besides the minute tick, a request also goes out at once when the sender comes online.
const RETRY_CAP_MS = 60_000;
// A peer flapping online/offline (app opened and closed) re-requests at most this often.
const PEER_ONLINE_MIN_GAP_MS = 10_000;
const RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // the sender can only help while its plaintext lives (retention TTL); only THEN give up
const TICK_MS = 15_000;

// Serialize recovery work per peer: a request-response rides a SINGLE recovery session address per peer
// (secretSession.recAddr), and two overlapping async handlers (e.g. a retry's response arriving mid-apply)
// would race on that session's store state. Chain per peer so each apply/respond runs to completion first.
const peerChains = new Map<string, Promise<unknown>>();
function withPeerLock<T>(peer: string, fn: () => Promise<T>): Promise<T> {
    const prev = peerChains.get(peer) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    peerChains.set(peer, run.catch(() => {}));
    return run;
}

export const e2eeRecoveryMiddleware: Middleware = (store) => {
    type S = {user?: {id?: string}; ws?: {status?: string}};
    const getMyId = () => (store.getState() as S).user?.id ?? "";
    const wsConnected = () => (store.getState() as S).ws?.status === "connected";

    const patchRow = (chatId: string, serverId: string, text: string) => {
        const myId = getMyId();
        if (!myId) return;
        store.dispatch(chatApi.util.updateQueryData("getChatHistory", {myId, chatId}, (draft) => {
            const row = draft?.find((r) => r.id === serverId);
            if (row) { row.text = text; row.secret = true; }
        }) as never);
    };

    const sendRequestsFor = async (items: PendingItem[]) => {
        // Group by peer+chat, batch the client ids into one request each.
        const groups = new Map<string, {peerId: string; chatId: string; ids: string[]}>();
        for (const it of items) {
            const k = it.peerId + "|" + it.chatId;
            (groups.get(k) ?? groups.set(k, {peerId: it.peerId, chatId: it.chatId, ids: []}).get(k)!).ids.push(it.clientId);
        }
        for (const g of groups.values()) {
            store.dispatch({type: "ws/send", payload: buildRequest(g.peerId, g.chatId, g.ids)});
            for (const id of g.ids) await bumpAttempt(id);
            logger.info("e2ee recovery: requested", {peerId: g.peerId, chatId: g.chatId, ids: g.ids.length});
        }
    };

    // Retry loop: re-request due items (capped backoff); give up + mark "lost" only past the 7-day window.
    let timer: ReturnType<typeof setInterval> | null = null;
    const startTimer = () => {
        if (timer) return;
        timer = setInterval(() => { void tick(); }, TICK_MS);
    };
    // `force`: re-request now, regardless of the backoff — all pending items (we reconnected) or one
    // peer's (that peer came online).
    const tick = async (force?: {peer?: string}) => {
        if (!wsConnected()) return;
        const now = Date.now();
        const pend = await allPending();
        // Give up ONLY once the sender can no longer help — past the 7-day recovery window (its plaintext is
        // gone by then anyway). Not after N quick retries: a sender offline for a few minutes is normal, and
        // a late response would otherwise be dropped and the message wrongly shown "lost".
        const expired = pend.filter((p) => now - p.createdAt > RECOVERY_WINDOW_MS);
        for (const p of expired) { patchRow(p.chatId, p.serverId, i18n.t(secretStateKey("expired"))); await removePending(p.clientId); }  // aged out, not a failure
        // Re-request due items with capped exponential backoff (so long-pending items still retry ~every 5 min).
        const forced = (p: PendingItem) => !!force && (force.peer === undefined || force.peer === p.peerId);
        const due = pend.filter((p) => now - p.createdAt <= RECOVERY_WINDOW_MS && (forced(p) ||
            now - p.lastAt > Math.min(RETRY_CAP_MS, RETRY_BASE_MS * Math.pow(RETRY_FACTOR, p.attempts))));
        if (due.length) await sendRequestsFor(due);
    };

    const lastPeerOnline = new Map<string, number>();
    const peerOnline = (peer: string) => {
        const now = Date.now();
        if (now - (lastPeerOnline.get(peer) ?? 0) < PEER_ONLINE_MIN_GAP_MS) return;
        lastPeerOnline.set(peer, now);
        void tick({peer});
    };

    let wasConnected = false;
    return (next) => (action) => {
        const result = next(action);
        const a = action as {type?: string; payload?: unknown};
        startTimer();

        // On (re)connect, re-request everything pending at once — we may have been the absent side (the
        // Android app in the background), and a sender who was offline may now be reachable.
        const nowConnected = wsConnected();
        if (nowConnected && !wasConnected) void tick({});
        wasConnected = nowConnected;

        // A sender came online (PRESENT_JOIN): ask it now. The PRESENT_INIT snapshot comes with our own
        // (re)connect, which has already re-requested everything above.
        if (a?.type === presenceJoin.type) {
            const id = (a.payload as ClientData | undefined)?.id;
            if (id) peerOnline(id);
        }

        // (1) chatMiddleware reports messages it couldn't decrypt → mark pending, request now.
        if (a?.type === REPORT_UNDECRYPTABLE) {
            const {chatId, peerId, items} = (a as ReportUndecryptable).payload;
            if (items.length) void (async () => {
                const added = await addPending(items.map((it) => ({...it, chatId, peerId})));
                if (added.length) await sendRequestsFor(added);
            })();
            return result;
        }

        // (2) incoming SIGNAL recovery frames (routed here via frameBridge e2ee: → SIGNAL).
        if (a?.type === "ws/incoming") {
            const f = a.payload as {type?: string; from?: string; conversationId?: string; clientIds?: string[]; items?: RecoverResp["items"]; missing?: string[]};

            // Rekey hint: a peer's device received a message we addressed to a stale device of theirs. Drop our
            // cached roster for that peer so the next send re-resolves from the directory (and encrypts to all
            // their current devices). Only a trigger to re-fetch — never trusts any device from the hint.
            if (f?.type === REKEY_HINT && f.from) {
                const peer = f.from;
                if (rekeyActThrottle(peer)) void (async () => {
                    try {
                        const {store} = await ensureProvisioned();
                        await invalidatePeer(store, peer);
                        logger.info("e2ee: rekey hint → peer roster invalidated", {peer});
                    } catch (e) { logger.warn("e2ee: rekey hint handling failed", e as Error); }
                })();
                return result;
            }
            if (f?.type === RECOVER_REQ && f.from && f.conversationId && Array.isArray(f.clientIds)) {
                void withPeerLock(f.from, async () => {
                    try {
                        const resp = await buildResponse(f.from!, f.conversationId!, f.clientIds!);
                        // Send if we have ANYTHING to say — recovered items OR a NACK for what we can't provide.
                        // A silent no-op here is what leaves the requester waiting out the whole retry budget.
                        if (resp.items.length || resp.missing.length) store.dispatch({type: "ws/send", payload: resp satisfies RecoverResp});
                    } catch (e) { logger.warn("e2ee recovery: respond failed", e as Error); }
                });
                return result;
            }
            if (f?.type === RECOVER_RESP && f.from && f.conversationId && Array.isArray(f.items)) {
                void withPeerLock(f.from, async () => {
                    try {
                        const recovered = await applyResponse(f.from!, f.conversationId!, f.items!);
                        const missing = Array.isArray(f.missing) ? f.missing : [];
                        const pend = await allPending();
                        const byClient = new Map(pend.map((p) => [p.clientId, p]));
                        // A response may only touch pending items we actually requested FROM this responder,
                        // for THIS chat. clientIds aren't secret and ride the frames, so without this a third
                        // party could forge a `missing` NACK and force a still-recoverable message to "lost".
                        // The recovered path is already crypto-authenticated (decryptRecovery binds sender +
                        // chat + id); this guards the NACK path, which carries no such proof, symmetrically.
                        const mine = (p?: PendingItem): p is PendingItem => !!p && p.peerId === f.from && p.chatId === f.conversationId;
                        const done = new Set<string>();
                        for (const {forClientId, plaintext} of recovered) {
                            const p = byClient.get(forClientId);
                            if (!mine(p)) continue;
                            await savePlaintext(p.serverId, p.chatId, plaintext);
                            patchRow(p.chatId, p.serverId, plaintext);
                            await removePending(forClientId);
                            done.add(forClientId);
                        }
                        // Definitive NACK from the sender: it sent these but no longer holds them (past the 7-day
                        // window) or never did — mark lost NOW instead of waiting out the retry budget. Never
                        // clobber a message the same response just recovered (id in both lists).
                        let lost = 0;
                        for (const mid of missing) {
                            if (done.has(mid)) continue;
                            const p = byClient.get(mid);
                            if (!mine(p)) continue;
                            patchRow(p.chatId, p.serverId, i18n.t(secretStateKey("lost")));
                            await removePending(mid);
                            lost++;
                        }
                        logger.info("e2ee recovery: applied", {recovered: done.size, lost, items: f.items!.length});
                    } catch (e) { logger.warn("e2ee recovery: apply failed", e as Error); }
                });
                return result;
            }
        }
        return result;
    };
};

// silence unused-type import in some TS configs
export type {RecoverReq};
