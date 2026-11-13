import type {Middleware, PayloadAction} from "@reduxjs/toolkit";
import type {WSMessage} from "@/infrastructure/types.ts";
import type {AppDispatch, RootState} from "@/store/store.ts";
import {chatApi} from "@/features/chat/rest/chatApi.ts";
import {groupApi} from "@/features/groups/rest/groupApi.ts";
import {chatMessagesService} from "@/features/chat/model/services/chatMessages.service.ts";
import {wireToChatMessage} from "@/features/chat/model/mapper.ts";
import {upsertMessage} from "@/features/chat/model/historyCache.ts";
import {buildChatAck, buildReadIn, type WireMessage} from "@/features/chat/model/schema/wireMessage.schema.ts";
import {markChatUnread, setPeerLastReadId, setTyping} from "@/features/chat/model/slices/chatUiSlice.ts";
import {markSent} from "@/features/chat/model/slices/outboxSlice.ts";
import {logger} from "@/shared/logger/logger.ts";
import {playNotificationSound} from "@/shared/sound/notify.ts";
import {showDesktopNotification} from "@/features/notifications";
import {secretCrypto, secretAvailable, reportUndecryptable, savePlaintext, loadPlaintext, E2EE_PLAINTEXT_TTL_MS} from "@/features/e2ee";
import {isSecretEnvelope, classifyDecryptError, isRecoverable, isWrongDevice, secretStateKey, buildRekeyHint, makeThrottle, REKEY_COALESCE_MS} from "@/features/e2ee/wire.ts";
import {ulidTimeMs, isUlid} from "@/shared/ulid/ulid.ts";
import i18n from "@/shared/i18n";
import {markSecret} from "@/features/chat/model/slices/secretChatsSlice.ts";

// How long a "peer is typing" indicator lingers before auto-clearing if no follow-up frame.
const TYPING_TIMEOUT_MS = 4000;

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
async function flagIfNotSaved(dispatch: AppDispatch, myId: string, chatId: string, id: string, saved: Promise<boolean>): Promise<void> {
    if (await saved) return;
    dispatch(chatApi.util.updateQueryData("getChatHistory", {myId, chatId}, (draft) => {
        const row = draft?.find((r) => r.id === id);
        if (row) row.unsaved = true;
    }));
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

    // History (re)load: rows carry the raw E2EE envelope. For each secret message, restore the text —
    //   1. from the at-rest plaintext store (decrypted once on receipt / stashed at send), else
    //   2. (Step A) for an INCOMING message never decrypted live — the offline case, delivered ONLY via
    //      history — run the ratchet NOW, in history order (skipped-keys align small gaps), and stash it.
    // Own sent messages can't be ratchet-decrypted (the envelope is encrypted to the PEER), so those rely
    // on the store only. A hard failure (permanent gap / lost ciphertext) → "🔒 lost" (Step B will attempt
    // client-to-client recovery before giving up).
    if (chatApi.endpoints?.getChatHistory?.matchFulfilled?.(action)) {
        const {myId, chatId} = action.meta.arg.originalArgs as {myId: string; chatId: string};
        const rows = action.payload as Array<{id: string; clientId?: string; from?: string; text: string}>;
        const secret = rows.filter((m) => isSecretEnvelope(m.text));
        if (secret.length) {
            const d = store.dispatch as AppDispatch;
            // An encrypted message in the history means the chat is secret when this device remembers nothing
            // (localStorage cleared, a new install): mark it before the user can send anything in the clear.
            ensureSecretChat(store, chatId, false);
            void (async () => {
                const toRecover: Array<{clientId: string; serverId: string}> = [];
                let peerId = "";
                for (const m of secret) {
                    let plain = (await loadPlaintext(m.id, E2EE_PLAINTEXT_TTL_MS)) ?? (m.clientId ? await loadPlaintext(m.clientId, E2EE_PLAINTEXT_TTL_MS) : null);
                    // "Aged out": older than the retention window → the plaintext (ours and the sender's) is
                    // swept by design. This is a disappearing message, NOT a decrypt failure — don't attempt
                    // recovery (the sender's copy is gone too), and show "expired", not "lost".
                    const aged = plain == null && isUlid(m.id) && Date.now() - ulidTimeMs(m.id) > E2EE_PLAINTEXT_TTL_MS;
                    let recoverable = false;
                    if (plain == null && !aged && m.from && m.from !== myId && secretAvailable()) {
                        // Never decrypted live → try the ratchet now (in-order over history).
                        try {
                            plain = await secretCrypto.decrypt(m.from, m.text);
                            void flagIfNotSaved(d, myId, chatId, m.id, savePlaintext(m.id, chatId, plain));
                        }
                        catch (e) {
                            // Permanent gap / lost ciphertext → hand off to client-to-client recovery (Step B),
                            // correlated by the sender's client id. Show "⏳ re-requested" until it resolves/expires.
                            if (m.clientId) { toRecover.push({clientId: m.clientId, serverId: m.id}); peerId = m.from; recoverable = true; }
                            // Mis-addressed to another of our devices (offline history only ever delivered it) →
                            // nudge the sender to re-resolve our roster, same as the live path, so future sends
                            // reach us without waiting out the 24h roster TTL. Coalesced per peer.
                            if (m.from && isWrongDevice(classifyDecryptError(e)) && rekeyHintThrottle(m.from)) {
                                d({type: "ws/send", payload: buildRekeyHint(m.from, chatId)});
                            }
                        }
                    }
                    // "lost" ONLY when we actually tried and failed within the window. Own messages we can't
                    // re-derive from history (the envelope is encrypted to the peer) → "unavailable".
                    const state = !secretAvailable() ? "appOnly"
                        : aged ? "expired"
                        : recoverable ? "pending"
                        : m.from === myId ? "unavailable"
                        : "lost";
                    const fallback = i18n.t(secretStateKey(state));
                    d(chatApi.util.updateQueryData("getChatHistory", {myId, chatId}, (draft) => {
                        const row = draft?.find((r) => r.id === m.id);
                        if (row) { row.text = plain ?? fallback; row.secret = true; }
                    }));
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

            // SECRET (E2EE) message: the wire body is an opaque envelope. Store a placeholder now, then
            // decrypt asynchronously (the ratchet is async + single-writer) and patch the row's text in.
            const secretBody = isSecretEnvelope(msg.text) ? msg.text : null;
            if (secretBody) {
                msg.text = i18n.t("chat.decrypting"); msg.secret = true;
                // The peer writes encrypted → the chat is secret on this side too, so the reply is encrypted.
                ensureSecretChat(store, chatId, true);
            }

            // Append to the open conversation's history (idempotent). No-op if that query has
            // no subscriber (chat not open) — the message loads over REST when it's opened.
            dispatch(
                chatApi.util.updateQueryData("getChatHistory", {myId, chatId}, (draft) => {
                    if (!draft) return;
                    // Canonical dedup (id || clientId) — see model/historyCache. Catches a lost-ACK
                    // resend (stored under a fresh server id) and an already-shown optimistic echo.
                    upsertMessage(draft, msg);
                })
            );

            if (secretBody) {
                const patch = (text: string) => dispatch(
                    chatApi.util.updateQueryData("getChatHistory", {myId, chatId}, (draft) => {
                        const row = draft?.find((m) => m.id === msg.id);
                        if (row) row.text = text;
                    })
                );
                const cid = msg.clientId;
                void (async () => {
                    // Durable dedup FIRST: the Double Ratchet consumes each message key exactly once, so
                    // re-decrypting a redelivered ciphertext (lost-ACK resend, or live+history overlap) throws
                    // a dup-reject. If we already hold the plaintext — under this server id OR the sender's
                    // stable client id — reuse it and never touch the ratchet.
                    const seen = (await loadPlaintext(msg.id, E2EE_PLAINTEXT_TTL_MS))
                        ?? (cid ? await loadPlaintext(cid, E2EE_PLAINTEXT_TTL_MS) : null);
                    if (seen != null) { patch(seen); return; }
                    // A browser has no keys: it shows where the message can be read and asks the sender for nothing.
                    if (!secretAvailable()) { patch(i18n.t(secretStateKey("appOnly"))); return; }
                    try {
                        const plain = await secretCrypto.decrypt(frame.senderId ?? msg.from, secretBody);
                        patch(plain);
                        // for reloaded history (by server id); a failed save is shown on the bubble
                        void flagIfNotSaved(dispatch, myId, chatId, msg.id, savePlaintext(msg.id, chatId, plain));
                        if (cid) void savePlaintext(cid, chatId, plain);        // + by client id, so a resend dedups
                    } catch (e) {
                        // A stored copy always wins. Otherwise classify: a recoverable gap (past MAX_SKIP, no
                        // session yet) is handed to client-to-client recovery NOW — the live path used to
                        // dead-end at "unavailable" and only recover on a later history reload — and shown as
                        // "⏳ re-requested"; a corrupt/undecodable frame is a plain "unavailable".
                        const stored = await loadPlaintext(msg.id);
                        if (stored != null) { patch(stored); return; }
                        const peerId = frame.senderId ?? msg.from;
                        const failure = classifyDecryptError(e);
                        // Mis-addressed to another of our devices → nudge the sender to re-resolve our roster
                        // (metadata-only hint, coalesced per peer). The message itself is still recovered below.
                        if (peerId && isWrongDevice(failure) && rekeyHintThrottle(peerId)) {
                            dispatch({type: "ws/send", payload: buildRekeyHint(peerId, chatId)});
                        }
                        if (cid && peerId && isRecoverable(failure)) {
                            patch(i18n.t(secretStateKey("pending")));
                            dispatch(reportUndecryptable({chatId, peerId, items: [{clientId: cid, serverId: msg.id}]}) as never);
                        } else {
                            patch(i18n.t(secretStateKey("unavailable")));
                        }
                    }
                })();
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

            // ACK delivery (SENT → DELIVERED; advances the server GC watermark).
            dispatch({type: "ws/send", payload: buildChatAck(frame)});
            clearTypingTimer(chatId);
            dispatch(setTyping({chatId, typing: false}));

            // "Actively viewing" = the chat is open AND the tab is visible. Only then is it truly
            // read; a message that arrives while the tab is hidden is marked unread (and the
            // deferred read fires when the tab regains focus — see useChat).
            const hidden = typeof document !== "undefined" && document.hidden;
            const active = chatId === selectedChatId && !hidden;
            if (active) {
                // Read boundary = this just-delivered message's id (a server ULID), so the peer's
                // durable receipt advances to it.
                if (frame.senderId) dispatch({type: "ws/send", payload: buildReadIn(chatId, frame.senderId, frame.messageId)});
            } else {
                dispatch(markChatUnread(chatId));
                // Best-effort notify when not actively viewing.
                playNotificationSound();
                // Pass the server message id so the SW arbiter can dedup this online notification
                // against an offline Web Push for the SAME message (both carry the server ULID).
                // Body: a real text message, else a GENERIC "attachment" — never the file name (it's
                // noise, and we can't name the sender anyway, so keep it to "new message" + text/attachment).
                if (hidden) {
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
            // the open history (inserted optimistically at enqueue, keyed by the client messageId).
            // We deliberately do NOT re-read the history here: getChatHistory forward-pages the WHOLE
            // conversation, so a refetch per ACK re-downloaded up to thousands of rows just to swap
            // one temporary id for the server ULID — a real cost on every send. Instead we reconcile
            // in place: stamp the echo with the server timestamp so its ✓/✓✓ read-receipt timing
            // matches the server clock (the list is sorted by createdAt, and server stamps are
            // monotonic, so ordering is preserved). The temporary client id is upgraded to the real
            // ULID on the next natural read-through (the reconnect refetch in useChat). The ACK does
            // NOT carry the stored message's id — its messageId is the ack frame's own id.
            dispatch(markSent(frame.correlationId));
            const chatId = frame.conversationId ?? selectedChatId;
            const at = frame.serverTimestamp;
            // The STORED server ULID (backend contract: CHAT_ACK.serverMessageId — capture it!).
            // NOT messageId (that is the ack frame's own id). Reconciling my optimistic echo to it
            // lets a just-sent message match the peer's read watermark and flip to ✓✓ without a reload.
            const serverId = frame.serverMessageId;
            if (chatId && (typeof at === "number" || serverId)) {
                dispatch(
                    chatApi.util.updateQueryData("getChatHistory", {myId, chatId}, (draft) => {
                        const m = draft?.find(
                            (x) => x.clientId === frame.correlationId || x.id === frame.correlationId
                        );
                        if (!m) return;
                        // Reconcile the optimistic echo: swap its temporary client id for the real
                        // server ULID (so delete/read-boundary work by id), and stamp server time.
                        if (serverId) m.id = serverId;
                        if (typeof at === "number") m.createdAt = new Date(at);
                    })
                );
            }
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

// Per-conversation "typing" auto-clear timers, so rapid TYPING_OUT frames don't stack timeouts.
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearTypingTimer(chatId: string) {
    const t = typingTimers.get(chatId);
    if (t) {
        clearTimeout(t);
        typingTimers.delete(chatId);
    }
}
