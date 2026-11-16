import type {Middleware, PayloadAction} from "@reduxjs/toolkit";
import type {WSMessage} from "@/infrastructure/types.ts";
import type {AppDispatch, RootState} from "@/store/store.ts";
import {chatApi} from "@/features/chat/rest/chatApi.ts";
import {groupApi} from "@/features/groups/rest/groupApi.ts";
import {takenAt} from "@/features/chat/model/mapper.ts";
import {ackTaken, answerTaken, selectRows} from "@/features/chat/model/slices/chatHistorySlice.ts";
import type {WireMessage} from "@/features/chat/model/schema/wireMessage.schema.ts";
import {setPeerLastReadId, setTyping} from "@/features/chat/model/slices/chatUiSlice.ts";
import {markSent, markFailed} from "@/features/chat/model/slices/outboxSlice.ts";
import {reportUndecryptable} from "@/features/e2ee";
import {isSecretEnvelope} from "@/features/e2ee/wire.ts";
import {recordIncoming, refreshListsIfUnknown} from "@/features/chat/incoming/record.ts";
import {ensureSecretChat, restoreSecretText, type ToRecover} from "@/features/chat/incoming/secretText.ts";
import {tellApp} from "@/features/chat/incoming/notify.ts";
import {acknowledge} from "@/features/chat/incoming/acknowledge.ts";
import {markIncoming} from "@/features/chat/incoming/mark.ts";
import type {IncomingStore} from "@/features/chat/incoming/types.ts";

// How long a "peer is typing" indicator lingers before auto-clearing if no follow-up frame.
const TYPING_TIMEOUT_MS = 4000;

/**
 * Routes incoming chat/read/typing WS frames per-frame, the same way presenceMiddleware routes
 * PRESENT_* frames. This is deliberately NOT a React effect on `ws.lastIncoming`: that slot holds
 * only the LAST frame, so a burst of frames arriving between renders would drop all but the last
 * (lost messages + missing ACKs). Reacting to every `ws/incoming` action here processes each frame
 * exactly once, synchronously, before the next one can overwrite anything.
 *
 * A message (CHAT_OUT) goes through the steps of features/chat/incoming, in this order (spec 003,
 * FR-053): into the chat (record), its secret text (secretText — the same for a row of the history),
 * the Android app is told (notify), the server learns it is delivered (acknowledge), read or unread
 * (mark).
 */
export const chatMiddleware: Middleware = (store) => (next) => (action) => {
    const result = next(action);
    const steps: IncomingStore = {getState: store.getState as () => RootState, dispatch: store.dispatch as AppDispatch};

    // An answer of the history has been merged into the chat: its rows carry the raw envelope. The text of
    // each secret message is restored (secretText), one after another in the order of the history; what
    // cannot be decrypted is asked of the sender in one request.
    if (answerTaken.match(action)) {
        const chatId = action.payload.chatId;
        const myId = steps.getState().user?.id;
        // A row whose text this device holds only in memory (it could not be stored) keeps it through the
        // merge: there is nothing to restore, and the library would refuse the same envelope a second time.
        const inMemoryOnly = new Set(selectRows(steps.getState(), chatId)?.filter((r) => r.unsaved).map((r) => r.id));
        const secret = action.payload.answer.filter((m) => isSecretEnvelope(m.text) && !inMemoryOnly.has(m.id));
        if (secret.length && myId) {
            // An encrypted message in the history means the chat is secret when this device remembers nothing
            // (localStorage cleared, a new install): mark it before the user can send anything in the clear.
            ensureSecretChat(steps, chatId, false);
            void (async () => {
                const toRecover: ToRecover[] = [];
                let peerId = "";
                for (const m of secret) {
                    const ask = await restoreSecretText(steps, {chatId, id: m.id, clientId: m.clientId, from: m.from, envelope: m.text}, "history");
                    if (ask) { toRecover.push(ask); peerId = m.from; }
                }
                if (toRecover.length && peerId) steps.dispatch(reportUndecryptable({chatId, peerId, items: toRecover}) as never);
            })();
        }
        return result;
    }

    const a = action as PayloadAction<WSMessage>;
    if (a?.type !== "ws/incoming") return result;

    const frame = a.payload as WireMessage;
    const st = store.getState();
    const myId = st.user?.id as string;
    const dispatch = steps.dispatch;

    switch (frame?.type) {
        case "CHAT_OUT": {
            const m = recordIncoming(steps, frame);
            if (!m) break;
            if (m.envelope) {
                void restoreSecretText(steps, {chatId: m.chatId, id: m.row.id, clientId: m.row.clientId, from: m.sender, envelope: m.envelope}, "socket")
                    .then((ask) => { if (ask) dispatch(reportUndecryptable({chatId: m.chatId, peerId: m.sender, items: [ask]}) as never); });
            }
            refreshListsIfUnknown(steps, m.chatId);
            acknowledge(steps, frame, tellApp(steps, m, frame.messageId));
            clearTypingTimer(m.chatId);
            dispatch(setTyping({chatId: m.chatId, typing: false}));
            markIncoming(steps, frame, m);
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

// Per-conversation "typing" auto-clear timers, so rapid TYPING_OUT frames don't stack timeouts.
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearTypingTimer(chatId: string) {
    const t = typingTimers.get(chatId);
    if (t) {
        clearTimeout(t);
        typingTimers.delete(chatId);
    }
}
