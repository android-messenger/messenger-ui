import {logger} from "@/shared/logger/logger.ts";
import {buildChatAck, type WireMessage} from "@/features/chat/model/schema/wireMessage.schema.ts";
import type {IncomingStore} from "./types.ts";

// Android app: how long the app may take to answer `notifyMessage` before the message is left
// unacknowledged (spec 003, FR-043).
export const NOTIFY_ANSWER_LIMIT_MS = 2_000;

/**
 * True once the app has taken the message; false if it refused or did not answer within the limit. An app
 * that has no such method is not a refusal: the bridge either has no function to call (tellApp gives
 * undefined) or answers UNIMPLEMENTED — the message is acknowledged as before the method existed.
 */
function takenByApp(told: Promise<unknown>): Promise<boolean> {
    return new Promise((resolve) => {
        const limit = setTimeout(() => resolve(false), NOTIFY_ANSWER_LIMIT_MS);
        told.then(
            () => { clearTimeout(limit); resolve(true); },
            (e: unknown) => { clearTimeout(limit); resolve((e as {code?: string} | null)?.code === "UNIMPLEMENTED"); },
        );
    });
}

/**
 * Step 4 of an incoming message: the server learns it is delivered (CHAT_ACK: SENT → DELIVERED, the server
 * may let it go) — at once, or, in the Android app, once the app has taken it (FR-043). Not taken in time,
 * or refused: no ACK, and the server sends it again or as a push. The row is already in the chat (step 1).
 */
export function acknowledge(store: IncomingStore, frame: WireMessage, told: Promise<unknown> | undefined): void {
    const ack = () => store.dispatch({type: "ws/send", payload: buildChatAck(frame)});
    if (!told) { ack(); return; }
    void takenByApp(told).then((taken) => {
        if (taken) ack();
        else logger.warn("push: the app did not take a socket message, it is not acknowledged", {chatId: frame.conversationId, messageId: frame.messageId});
    });
}
