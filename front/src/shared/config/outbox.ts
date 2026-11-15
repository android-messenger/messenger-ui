// The send queue.
//
// A queued message stays in the queue until the server confirms it with a CHAT_ACK (correlationId === the
// client messageId). The server does not join two frames of one client messageId into one message, so a
// message with no confirmation is sent at most once per connection of the socket (sendOutboxThunk).

// After this many connections without a confirmation the message is marked "not sent".
export const OUTBOX_RETRY_MAX_ATTEMPTS = 6;

// How often the queue is looked at (useOutboxRetry).
export const OUTBOX_RETRY_TICK_MS = 3_000;

// A message sent over a living connection and not confirmed for this long is marked "not sent": the user
// sees it with "retry" and "discard" instead of a clock that never ends.
export const OUTBOX_SEND_TIMEOUT_MS = 20_000;
