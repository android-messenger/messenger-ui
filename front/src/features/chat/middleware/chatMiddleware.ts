import type {Middleware, PayloadAction} from "@reduxjs/toolkit";
import type {WSMessage} from "@/infrastructure/types.ts";
import type {AppDispatch, RootState} from "@/store/store.ts";
import {chatApi} from "@/features/chat/rest/chatApi.ts";
import {groupApi} from "@/features/groups/rest/groupApi.ts";
import {chatMessagesService} from "@/features/chat/model/services/chatMessages.service.ts";
import {takenAt, wireToChatMessage} from "@/features/chat/model/mapper.ts";
import {ackTaken, answerTaken, rowFixed, selectRows, socketRow} from "@/features/chat/model/slices/chatHistorySlice.ts";
import {buildChatAck, buildReadIn, type WireMessage} from "@/features/chat/model/schema/wireMessage.schema.ts";
import {markChatUnread, setPeerLastReadId, setTyping} from "@/features/chat/model/slices/chatUiSlice.ts";
import {markSent, markFailed} from "@/features/chat/model/slices/outboxSlice.ts";
import {logger} from "@/shared/logger/logger.ts";
import {playNotificationSound} from "@/shared/sound/notify.ts";
import {showDesktopNotification} from "@/features/notifications";
import {secretCrypto, secretAvailable, reportUndecryptable, savePlaintext, loadPlaintext, inPeerOrder, E2EE_PLAINTEXT_TTL_MS} from "@/features/e2ee";
import {isSecretEnvelope, classifyDecryptError, isRecoverable, isWrongDevice, secretStateKey, buildRekeyHint, makeThrottle, REKEY_COALESCE_MS} from "@/features/e2ee/wire.ts";
import {ulidTimeMs, isUlid} from "@/shared/ulid/ulid.ts";
import i18n from "@/shared/i18n";
import {isNativeApp, push} from "@/shared/platform.ts";
import {isAppBackgrounded} from "@/infrastructure/native/appLifecycle.ts";
import {markSecret} from "@/features/chat/model/slices/secretChatsSlice.ts";

// How long a "peer is typing" indicator lingers before auto-clearing if no follow-up frame.
const TYPING_TIMEOUT_MS = 4000;

// Android app: how long the app may take to answer `notifyMessage` before the message is left
// unacknowledged (spec 003, FR-043).
export const NOTIFY_ANSWER_LIMIT_MS = 2_000;

/** True once the app has taken the message; false if it refused or did not answer within the limit. */
function takenByApp(told: Promise<unknown>): Promise<boolean> {
    return new Promise((resolve) => {
        const limit = setTimeout(() => resolve(false), NOTIFY_ANSWER_LIMIT_MS);
        told.then(() => { clearTimeout(limit); resolve(true); }, () => { clearTimeout(limit); resolve(false); });
    });
}

// Coalesce rekey hints: at most one per peer per window, however many mis-addressed envelopes arrive.
const rekeyHintThrottle = makeThrottle(REKEY_COALESCE_MS);

/**
 * Routes incoming chat/read/typing WS frames per-frame, the same way presenceMiddleware routes
 * PRESENT_* frames. This is deliberately NOT a React effect on `ws.lastIncoming`: that slot holds
 * only the LAST frame, so a burst of frames arriving between renders would drop all but the last
 * (lost messages + missing ACKs). Reacting to every `ws/incoming` action here processes each frame
 * exactly once, synchronously, before the next one can overwrite anything.
 */
/** A secret text that could not be stored is gone after a reload: mark its row so the user knows. */
async function flagIfNotSaved(dispatch: AppDispatch, chatId: string, id: string, saved: Promise<boolean>): Promise<void> {
    if (await saved) return;
    dispatch(rowFixed({chatId, id, fix: {unsaved: true}}));
}

/** The text of this message is on the screen and nowhere else: it could not be stored (flagIfNotSaved). */
function heldInMemory(state: RootState, chatId: string, id: string): boolean {
    return !!selectRows(state, chatId)?.some((r) => r.id === id && r.unsaved);
}

/** The stored text of a secret message — under its server id or the sender's client id. */
async function storedText(id: string, clientId: string | undefined): Promise<string | null> {
    return (await loadPlaintext(id, E2EE_PLAINTEXT_TTL_MS)) ?? (clientId ? await loadPlaintext(clientId, E2EE_PLAINTEXT_TTL_MS) : null);
}

/**
 * Marks the chat secret when an encrypted message is seen in it (see secretChatsSlice). `live` — the
 * message has just arrived: the peer writes encrypted now, so the mode goes on even if the user had turned
 * it off. From the history the mode goes on only when this device remembers nothing about the chat: old
 * encrypted messages must not undo the user's "off".
 */
function ensureSecretChat(store: {getState: () => unknown; dispatch: (a: never) => unknown}, chatId: string, live: boolean): void {
    const mode = (store.getState() as {secretChats?: {byId?: Record<string, boolean>}}).secretChats?.byId?.[chatId];
    if (chatId && (live ? !mode : mode === undefined)) store.dispatch(markSecret(chatId) as never);
}

export const chatMiddleware: Middleware = (store) => (next) => (action) => {
    const result = next(action);

    // An answer of the history has been merged into the chat: its rows carry the raw E2EE envelope. For each secret message, restore the text —
    //   1. from the at-rest plaintext store (decrypted once on receipt / stashed at send), else
    //   2. (Step A) for an INCOMING message never decrypted live — the offline case, delivered ONLY via
    //      history — run the ratchet NOW, in history order (skipped-keys align small gaps), and stash it.
    // Own sent messages can't be ratchet-decrypted (the envelope is encrypted to the PEER), so those rely
    // on the store only. A hard failure (permanent gap / lost ciphertext) → "🔒 lost" (Step B will attempt
    // client-to-client recovery before giving up).
    if (answerTaken.match(action)) {
        const chatId = action.payload.chatId;
        const myId = store.getState().user?.id as string;
        // A row whose text this device holds only in memory (it could not be stored) keeps it through the
        // merge: there is nothing to restore, and the ratchet would refuse the same envelope a second time.
        const inMemoryOnly = new Set(selectRows(store.getState(), chatId)?.filter((r) => r.unsaved).map((r) => r.id));
        const secret = action.payload.answer.filter((m) => isSecretEnvelope(m.text) && !inMemoryOnly.has(m.id));
        if (secret.length && myId) {
            const d = store.dispatch as AppDispatch;
            // An encrypted message in the history means the chat is secret when this device remembers nothing
            // (localStorage cleared, a new install): mark it before the user can send anything in the clear.
            ensureSecretChat(store, chatId, false);
            void (async () => {
                const toRecover: Array<{clientId: string; serverId: string}> = [];
                let peerId = "";
                for (const m of secret) {
                    // "Aged out": older than the retention window → the plaintext (ours and the sender's) is
                    // swept by design. This is a disappearing message, NOT a decrypt failure — don't attempt
                    // recovery (the sender's copy is gone too), and show "expired", not "lost".
                    const old = isUlid(m.id) && Date.now() - ulidTimeMs(m.id) > E2EE_PLAINTEXT_TTL_MS;
                    const from = m.from;
                    const read = async (): Promise<{plain: string | null; recoverable?: boolean; inMemory?: boolean}> => {
                        const plain = await storedText(m.id, m.clientId);
                        if (plain != null || old || !from || from === myId || !secretAvailable()) return {plain};
                        // The socket's branch decrypted it, and the text could not be stored: the row has it.
                        if (heldInMemory(store.getState(), chatId, m.id)) return {plain: null, inMemory: true};
                        // Never decrypted live → try the ratchet now (in-order over history).
                        try {
                            const text = await secretCrypto.decrypt(from, m.text);
                            await flagIfNotSaved(d, chatId, m.id, savePlaintext(m.id, chatId, text));
                            return {plain: text};
                        }
                        catch (e) {
                            // Mis-addressed to another of our devices (offline history only ever delivered it) →
                            // nudge the sender to re-resolve our roster, same as the live path, so future sends
                            // reach us without waiting out the 24h roster TTL. Coalesced per peer.
                            if (isWrongDevice(classifyDecryptError(e)) && rekeyHintThrottle(from)) {
                                d({type: "ws/send", payload: buildRekeyHint(from, chatId)});
                            }
                            // Permanent gap / lost ciphertext → hand off to client-to-client recovery (Step B),
                            // correlated by the sender's client id. Show "⏳ re-requested" until it resolves/expires.
                            if (!m.clientId) return {plain: null};
                            toRecover.push({clientId: m.clientId, serverId: m.id});
                            peerId = from;
                            return {plain: null, recoverable: true};
                        }
                    };
                    // A peer's message is looked up and decrypted in the peer's queue, one at a time with the
                    // socket's branch (FR-045); my own cannot be decrypted here at all — the stored text only.
                    const {plain, recoverable = false, inMemory = false} =
                        from && from !== myId ? await inPeerOrder(from, read) : await read();
                    if (inMemory) continue;
                    const aged = plain == null && old;
                    // "lost" ONLY when we actually tried and failed within the window. Own messages we can't
                    // re-derive from history (the envelope is encrypted to the peer) → "unavailable".
                    const state = !secretAvailable() ? "appOnly"
                        : aged ? "expired"
                        : recoverable ? "pending"
                        : m.from === myId ? "unavailable"
                        : "lost";
                    const fallback = i18n.t(secretStateKey(state));
                    d(rowFixed({chatId, id: m.id, fix: {text: plain ?? fallback, secret: true}}));
                }
                if (toRecover.length && peerId) d(reportUndecryptable({chatId, peerId, items: toRecover}) as never);
            })();
        }
        return result;
    }

    const a = action as PayloadAction<WSMessage>;
    if (a?.type !== "ws/incoming") return result;

    const frame = a.payload as WireMessage;
    const st = store.getState();
    const myId = st.user?.id as string;
    const selectedChatId = (st.chatUi?.selectedChatId as string | null) ?? null;
    // The middleware's dispatch is typed as plain Dispatch; cast to the app's ThunkDispatch so
    // RTK Query thunks (updateQueryData / initiate) type-check like they do in the services.
    const dispatch = store.dispatch as AppDispatch;

    switch (frame?.type) {
        case "CHAT_OUT": {
            const msg = wireToChatMessage(frame);
            const chatId = msg.chatId;
            if (!chatId) break;
            // the frame's time is the time of this delivery; the row keeps the time the message was taken in
            msg.createdAt = new Date(takenAt(msg.id, msg.createdAt.getTime()));

            // SECRET (E2EE) message: the wire body is an opaque envelope. Store a placeholder now, then
            // decrypt asynchronously (the ratchet is async + single-writer) and patch the row's text in.
            const secretBody = isSecretEnvelope(msg.text) ? msg.text : null;
            if (secretBody) {
                msg.text = i18n.t("chat.decrypting"); msg.secret = true;
                // The peer writes encrypted → the chat is secret on this side too, so the reply is encrypted.
                ensureSecretChat(store, chatId, true);
            }

            // A peer on an earlier build sends an unconfirmed message again and again, and the server stores
            // every frame as a message of its own: the same client id under another server id. It is one
            // row (below) and one notification: a copy is acknowledged and told to the app, and nothing more.
            const copy = isCopy(frame.senderId ?? msg.from, msg.clientId, msg.id);

            // Into the chat (spec 003, FR-012) — before the ACK below. The slice takes it if the chat's
            // rows are in or are being read, on the screen or not; a chat never opened reads it from the
            // server when it is opened. One message is one row (id || clientId, model/historyCache): a
            // lost-ACK resend and an already-shown echo do not double.
            dispatch(socketRow({chatId, row: msg}));

            if (secretBody) {
                const patch = (text: string) => dispatch(rowFixed({chatId, id: msg.id, fix: {text}}));
                const cid = msg.clientId;
                const sender = frame.senderId ?? msg.from;
                // In the sender's queue: one at a time with the history's branch and with the same frame
                // sent again, so one message is decrypted once (FR-045).
                void inPeerOrder(sender, async () => {
                    // The same frame again, and the text of the first one could not be stored: the row has it.
                    if (heldInMemory(store.getState() as RootState, chatId, msg.id)) return;
                    // Durable dedup FIRST: the Double Ratchet consumes each message key exactly once, so
                    // re-decrypting a redelivered ciphertext (lost-ACK resend, or live+history overlap) throws
                    // a dup-reject. If we already hold the plaintext — under this server id OR the sender's
                    // stable client id — reuse it and never touch the ratchet.
                    const seen = await storedText(msg.id, cid);
                    if (seen != null) { patch(seen); return; }
                    // A browser has no keys: it shows where the message can be read and asks the sender for nothing.
                    if (!secretAvailable()) { patch(i18n.t(secretStateKey("appOnly"))); return; }
                    try {
                        const plain = await secretCrypto.decrypt(sender, secretBody);
                        patch(plain);
                        if (cid) void savePlaintext(cid, chatId, plain);        // + by client id, so a resend dedups
                        // for reloaded history (by server id); a failed save is shown on the bubble. The next
                        // message of this sender waits for it: it must find this text, not decrypt again.
                        await flagIfNotSaved(dispatch, chatId, msg.id, savePlaintext(msg.id, chatId, plain));
                    } catch (e) {
                        // A stored copy always wins. Otherwise classify: a recoverable gap (past MAX_SKIP, no
                        // session yet) is handed to client-to-client recovery NOW — the live path used to
                        // dead-end at "unavailable" and only recover on a later history reload — and shown as
                        // "⏳ re-requested"; a corrupt/undecodable frame is a plain "unavailable".
                        const stored = await loadPlaintext(msg.id);
                        if (stored != null) { patch(stored); return; }
                        const failure = classifyDecryptError(e);
                        // Mis-addressed to another of our devices → nudge the sender to re-resolve our roster
                        // (metadata-only hint, coalesced per peer). The message itself is still recovered below.
                        if (sender && isWrongDevice(failure) && rekeyHintThrottle(sender)) {
                            dispatch({type: "ws/send", payload: buildRekeyHint(sender, chatId)});
                        }
                        if (cid && sender && isRecoverable(failure)) {
                            patch(i18n.t(secretStateKey("pending")));
                            dispatch(reportUndecryptable({chatId, peerId: sender, items: [{clientId: cid, serverId: msg.id}]}) as never);
                        } else {
                            patch(i18n.t(secretStateKey("unavailable")));
                        }
                    }
                });
            }

            // NOTE: we do NOT infer the peer's read state from an incoming message. Receiving a
            // reply does not imply the peer read my earlier messages — messages can cross (I send A,
            // the peer sends B without having seen A), which would light up a false ✓✓. The peer's
            // read state comes only from the receipts projection (history load) and the READ_OUT
            // frame below.

            // If this conversation isn't in the chat list yet (first message from a new peer),
            // refetch the list so the chat appears — but via the preserve-selected helper, NOT a bare
            // invalidateTags: a plain refetch would drop a freshly-created, still-hidden chat the user
            // has selected (GET /chats omits message-less convs), and the dangling-close would then
            // shut their open compose window.
            // The list spans two resources: DIRECT chats (getChats) and GROUPS (getGroups). Only treat
            // the conversation as "unknown" if it's in NEITHER — otherwise every incoming GROUP message
            // (never in getChats) would needlessly refetch /api/chats. If it's truly unknown, refresh the
            // direct list (preserve-selected) AND the groups list (covers being freshly added to a group).
            const inDirects = chatApi.endpoints.getChats.select({myId})(st)?.data
                ?.some((s) => s.conversationId === chatId);
            const inGroups = groupApi.endpoints.getGroups.select(undefined)(st)?.data
                ?.some((g) => g.id === chatId);
            if (!inDirects && !inGroups) {
                logger.debug("CHAT_OUT for unknown conversation, refreshing chat lists", chatId);
                chatMessagesService.refetchChatsPreservingSelected(dispatch, store.getState as () => RootState);
                dispatch(groupApi.endpoints.getGroups.initiate(undefined, {forceRefetch: true}));
            }

            // Spec 002 §3.3 — Android app: every message that comes over the socket is told to the app
            // BEFORE it is acknowledged. The app notes the message id, so a late push of the same message
            // shows nothing, and shows a notification itself when the user is not looking at the app (the
            // socket stays open for a moment after the app leaves the screen, and for the whole of a call).
            // Not taken in time, or refused — no ACK goes out (FR-043), and the server sends it again or as
            // a push. An app that has no such method (before 10191) is not asked: the ACK goes at once.
            const hidden = typeof document !== "undefined" && document.hidden;
            // ACK delivery (SENT → DELIVERED; advances the server GC watermark).
            const acknowledge = () => dispatch({type: "ws/send", payload: buildChatAck(frame)});
            let told: Promise<unknown> | undefined;
            if (isNativeApp()) {
                try {
                    told = push().notifyMessage({
                        conversationId: chatId, messageId: frame.messageId ?? msg.id, senderId: frame.senderId,
                        hidden: !copy && (hidden || isAppBackgrounded()),
                    });
                } catch (e) { logger.warn("push: no notifyMessage in this app", e as Error); }
            }
            if (!told) acknowledge();
            else {
                void takenByApp(told).then((taken) => {
                    if (taken) acknowledge();
                    else logger.warn("push: the app did not take a socket message, it is not acknowledged", {chatId, messageId: frame.messageId ?? msg.id});
                });
            }
            clearTypingTimer(chatId);
            dispatch(setTyping({chatId, typing: false}));

            // "Actively viewing" = the chat is open AND the tab is visible. Only then is it truly
            // read; a message that arrives while the tab is hidden is marked unread (and the
            // deferred read fires when the tab regains focus — see useChat).
            const active = chatId === selectedChatId && !hidden;
            if (active) {
                // Read boundary = this just-delivered message's id (a server ULID), so the peer's
                // durable receipt advances to it.
                if (frame.senderId) dispatch({type: "ws/send", payload: buildReadIn(chatId, frame.senderId, frame.messageId)});
            } else if (!copy) {   // a copy was counted and notified with the first one
                dispatch(markChatUnread(chatId));
                // Best-effort notify when not actively viewing.
                playNotificationSound();
                // Pass the server message id so the SW arbiter can dedup this online notification
                // against an offline Web Push for the SAME message (both carry the server ULID).
                // Body: a real text message, else a GENERIC "attachment" — never the file name (it's
                // noise, and we can't name the sender anyway, so keep it to "new message" + text/attachment).
                if (hidden && !isNativeApp()) {   // the Android app shows its own notification (above)
                    const body = secretBody ? i18n.t("chat.encryptedMessage")
                        : msg.kind === "attachment" ? i18n.t("chat.attachment") : (msg.text || "");
                    // Title stays generic here; the SW upgrades it to the sender's NAME from the persistent
                    // name cache (data.senderId) — same path the Web Push uses, so online and offline match.
                    showDesktopNotification(i18n.t("chat.newMessage"), body, chatId, msg.id, frame.senderId);
                }
            }
            break;
        }

        case "CHAT_ACK": {
            if (!frame.correlationId) break;
            // Our queued message was accepted → drop it from the outbox. The message is ALREADY in
            // the chat (put there at enqueue, keyed by the client messageId). The history is not read
            // again for it: the row is reconciled in place — the server's id instead of the temporary
            // client id (so delete and the read boundary work by id) and the server's time (so ✓/✓✓
            // timing matches the server clock). The ACK does NOT carry the stored message's id in
            // messageId — that is the ack frame's own id.
            // The chat is the one the message was queued for — not the one on the screen: the user may
            // have gone to another chat before the confirmation came (FR-032). The frame names the chat
            // only on a server that sends it (spec 002, S11).
            const queued = st.outbox?.messages.find((m: {id: string}) => m.id === frame.correlationId);
            dispatch(markSent(frame.correlationId));
            const chatId = queued?.payload.conversationId ?? frame.conversationId;
            const at = takenAt(frame.serverMessageId, frame.serverTimestamp);
            // The STORED server ULID (backend contract: CHAT_ACK.serverMessageId — capture it!).
            // NOT messageId (that is the ack frame's own id). Reconciling my optimistic echo to it
            // lets a just-sent message match the peer's read watermark and flip to ✓✓ without a reload.
            const serverId = frame.serverMessageId;
            if (chatId) dispatch(ackTaken({chatId, clientId: frame.correlationId, serverId, at}));
            break;
        }

        case "READ_OUT": {
            // Live peer read progress (backend contract): correlationId = the peer's new read-up-to
            // (a server ULID). Advance the ✓✓ watermark without refetching history. ULID-guarded +
            // monotonic in the reducer.
            if (frame.conversationId && frame.correlationId) {
                dispatch(setPeerLastReadId({chatId: frame.conversationId, lastReadId: frame.correlationId}));
            }
            break;
        }

        case "SERVICE_OUT": {
            // Best-effort roster-change hint (ADR-024): payload.kind = member_joined | member_left for
            // a group, payload.body = the subject user id. Invalidate that group's roster so the
            // RosterPanel / header re-fetch the authoritative membership. Non-durable — missed while
            // offline; the self-heal in ChatWindow (unknown sender → refetch) covers the gaps.
            const chatId = frame.conversationId;
            const p = frame.payload as {kind?: string; body?: string} | undefined;
            const kind = p?.kind;
            // The server refused my message as invalid (its chat is gone, it is not mine to write to): it
            // will never be taken, so it is "not sent" now and not after the retries run out. An
            // overloaded server ("overloaded") is not a refusal: the message is sent again.
            if (kind === "event" && p?.body === "invalid" && frame.correlationId) {
                dispatch(markFailed(frame.correlationId));
                break;
            }
            if (chatId && (kind === "member_joined" || kind === "member_left")) {
                dispatch(chatApi.util.invalidateTags([{type: "Chat", id: `group-members:${chatId}`}]));
                // If *I* am the subject, my groups LIST changed — refetch it so a group I was just added
                // to appears in my chat list (or a group I was removed from drops) without a refresh.
                if (p?.body === myId) {
                    dispatch(groupApi.endpoints.getGroups.initiate(undefined, {forceRefetch: true}));
                }
            }
            break;
        }

        case "TYPING_OUT": {
            const chatId = frame.conversationId;
            if (!chatId) break;
            dispatch(setTyping({chatId, typing: true, author: frame.senderId}));
            // Auto-clear, replacing any pending timer for this chat (no unbounded timer pile-up).
            clearTypingTimer(chatId);
            typingTimers.set(
                chatId,
                setTimeout(() => {
                    typingTimers.delete(chatId);
                    dispatch(setTyping({chatId, typing: false}));
                }, TYPING_TIMEOUT_MS)
            );
            break;
        }
    }

    return result;
};

// The client ids of the messages that came over the socket, with the server id each came under first.
// Kept for this start of the application, the last SEEN_MAX of them.
const SEEN_MAX = 500;
const seen = new Map<string, string>();

/** True if a message of this sender with this client id has already come under ANOTHER server id. The same
 * server id again is the same delivery repeated (its acknowledgement was lost), not a copy. */
function isCopy(senderId: string, clientId: string | undefined, serverId: string): boolean {
    if (!senderId || !clientId) return false;
    const key = `${senderId}|${clientId}`;
    const first = seen.get(key);
    if (first !== undefined) return first !== serverId;
    seen.set(key, serverId);
    if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value as string);
    return false;
}

// Per-conversation "typing" auto-clear timers, so rapid TYPING_OUT frames don't stack timeouts.
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearTypingTimer(chatId: string) {
    const t = typingTimers.get(chatId);
    if (t) {
        clearTimeout(t);
        typingTimers.delete(chatId);
    }
}
