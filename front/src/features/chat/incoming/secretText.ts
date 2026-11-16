import i18n from "@/shared/i18n";
import {ulidTimeMs, isUlid} from "@/shared/ulid/ulid.ts";
import {rowFixed, selectRows} from "@/features/chat/model/slices/chatHistorySlice.ts";
import {markSecret} from "@/features/chat/model/slices/secretChatsSlice.ts";
import {secretCrypto, secretAvailable, savePlaintext, loadPlaintext, inPeerOrder, E2EE_PLAINTEXT_TTL_MS} from "@/features/e2ee";
import {classifyDecryptError, isRecoverable, isWrongDevice, secretStateKey, buildRekeyHint, makeThrottle, REKEY_COALESCE_MS} from "@/features/e2ee/wire.ts";
import type {IncomingStore} from "./types.ts";

// The text of a secret (E2EE) message — the ONE place it is restored, for a message that came over the
// socket and for a row of an answer of the history (spec 003, FR-045, scenario 6.5). The row is put into
// the chat with the envelope (or "decrypting…"); this finds the text and puts it into the row:
//   1. the row already has it, and it is nowhere else (it could not be stored): nothing to do;
//   2. the text stored on this device — under the server id or the sender's client id;
//   3. the app's library decrypts it (the browser has no keys) and the text is stored;
//   4. it cannot be decrypted: the sender is asked for it (client-to-client recovery, Step B) or the row
//      says why it cannot be read.
// A message of a peer is restored in the peer's queue (inPeerOrder): the library spends a message key on
// the first decryption, so one message is decrypted once however many times it arrives.
//
// What the two ways still do differently, on purpose:
//   - a row of the history older than the time texts are kept (E2EE_PLAINTEXT_TTL_MS) is "expired", not
//     decrypted — the sender's copy is gone too; a message over the socket is new;
//   - my own message in the history cannot be decrypted (the envelope is for the peer): the stored text or
//     "unavailable";
//   - a failure in the history asks the sender whenever the message has a client id, and is "lost"
//     otherwise; over the socket only a failure the sender can mend (a gap, no session yet) asks, the rest
//     is "unavailable".

export type Via = "socket" | "history";

export interface SecretMessage {
    chatId: string;
    id: string;
    clientId?: string;
    from: string;
    envelope: string;
}

/** A message whose text the sender is asked for (reportUndecryptable). */
export interface ToRecover {
    clientId: string;
    serverId: string;
}

// Rekey hints: at most one per peer per window, however many mis-addressed envelopes arrive.
const rekeyHintThrottle = makeThrottle(REKEY_COALESCE_MS);

/** The stored text of a secret message — under its server id or the sender's client id. */
async function storedText(id: string, clientId: string | undefined): Promise<string | null> {
    return (await loadPlaintext(id, E2EE_PLAINTEXT_TTL_MS)) ?? (clientId ? await loadPlaintext(clientId, E2EE_PLAINTEXT_TTL_MS) : null);
}

/** The text of this message is on the screen and nowhere else: it could not be stored. */
export function heldInMemory(state: Parameters<typeof selectRows>[0], chatId: string, id: string): boolean {
    return !!selectRows(state, chatId)?.some((r) => r.id === id && r.unsaved);
}

/**
 * Marks the chat secret when an encrypted message is seen in it (see secretChatsSlice). `live` — the
 * message has just arrived: the peer writes encrypted now, so the mode goes on even if the user had turned
 * it off. From the history the mode goes on only when this device remembers nothing about the chat: old
 * encrypted messages must not undo the user's "off".
 */
export function ensureSecretChat(store: IncomingStore, chatId: string, live: boolean): void {
    const mode = store.getState().secretChats?.byId?.[chatId];
    if (chatId && (live ? !mode : mode === undefined)) store.dispatch(markSecret(chatId));
}

/**
 * Restores the text of one secret message into its row. Resolves when it is done, with the message to ask
 * the sender for, if any — the caller asks (one request for a whole answer of the history).
 */
export function restoreSecretText(store: IncomingStore, m: SecretMessage, via: Via): Promise<ToRecover | null> {
    const {chatId, id, clientId, from} = m;
    const myId = store.getState().user?.id;
    const fromHistory = via === "history";
    const show = (text: string) => store.dispatch(rowFixed({chatId, id, fix: {text, secret: true}}));
    const say = (state: Parameters<typeof secretStateKey>[0]) => show(i18n.t(secretStateKey(state)));

    const restore = async (): Promise<ToRecover | null> => {
        if (heldInMemory(store.getState(), chatId, id)) return null;
        const stored = await storedText(id, clientId);
        if (stored != null) { show(stored); return null; }
        if (!secretAvailable()) { say("appOnly"); return null; }
        if (fromHistory && isUlid(id) && Date.now() - ulidTimeMs(id) > E2EE_PLAINTEXT_TTL_MS) { say("expired"); return null; }
        if (fromHistory && (!from || from === myId)) { say(from === myId ? "unavailable" : "lost"); return null; }
        try {
            const text = await secretCrypto.decrypt(from, m.envelope);
            show(text);
            if (clientId) void savePlaintext(clientId, chatId, text);   // + by client id: a copy sent again finds it
            // By the server id, for the history read again; a failed save is shown on the row. The next
            // message of this sender waits for it: it must find this text, not decrypt again.
            if (!(await savePlaintext(id, chatId, text))) store.dispatch(rowFixed({chatId, id, fix: {unsaved: true}}));
            return null;
        } catch (e) {
            const again = await loadPlaintext(id);   // a stored copy always wins
            if (again != null) { show(again); return null; }
            const failure = classifyDecryptError(e);
            // Mis-addressed to another of our devices → nudge the sender to re-resolve our roster
            // (metadata only, coalesced per peer). The message itself is still asked for below.
            if (from && isWrongDevice(failure) && rekeyHintThrottle(from)) {
                store.dispatch({type: "ws/send", payload: buildRekeyHint(from, chatId)});
            }
            if (clientId && from && (fromHistory || isRecoverable(failure))) { say("pending"); return {clientId, serverId: id}; }
            say(fromHistory ? "lost" : "unavailable");
            return null;
        }
    };
    // A peer's message waits in the peer's queue; my own cannot be decrypted at all — the stored text only.
    return from && (!fromHistory || from !== myId) ? inPeerOrder(from, restore) : restore();
}
