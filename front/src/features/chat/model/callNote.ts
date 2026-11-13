// A call that was not answered leaves a line in the chat (owner's decision 2026-11-13): the caller sends
// an ordinary message when the call ends unanswered, so both sides have it in the history, the callee gets
// a push and an unread mark — also when the phone was off. No server change.
//
// The message carries the mark in `meta` and a readable text in the body. A client that knows the mark
// shows the line in its own language; any other client, and the push notification, show the body.

export const CALL_NOTE_KEY = "call";
export const CALL_NOTE_MISSED = "missed";

type Meta = Record<string, string> | undefined;

/** The marks of an unanswered call. */
export function missedCallMeta(audioOnly: boolean): Record<string, string> {
    return {[CALL_NOTE_KEY]: CALL_NOTE_MISSED, media: audioOnly ? "audio" : "video"};
}

/** The i18n key of the line for a message with the mark, or null for an ordinary message. */
export function callNoteKey(meta: Meta): "chat.missedCall" | "chat.missedVideoCall" | null {
    if (meta?.[CALL_NOTE_KEY] !== CALL_NOTE_MISSED) return null;
    return meta.media === "video" ? "chat.missedVideoCall" : "chat.missedCall";
}
