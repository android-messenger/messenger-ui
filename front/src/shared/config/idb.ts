export const DB_NAME = 'chatDB';
export const STORE_NAME = 'outbox';
export const STORE_KEY = 'messages';
// Per-conversation history cache (keyed by chatId) — instant open + offline read.
export const HISTORY_STORE_NAME = 'history';
// Unified media-attachment blob cache (images thumbnails, voice notes, video…), keyed by attachmentId
// (value = a Blob) so the chat renders media instantly without re-resolving/re-downloading. Size-bounded
// with oldest-first eviction (see db.ts). A companion index store holds [{id,size}] insertion order +
// sizes so the eviction never has to read the (heavy) blob data.
export const ATTACHMENT_BLOB_STORE = 'attachment-blobs';
export const ATTACHMENT_INDEX_STORE = 'attachment-blobs-index';
export const ATTACHMENT_INDEX_KEY = 'index';
// Legacy stores (v3/v4), replaced by the unified cache above — deleted in the v5 upgrade.
export const THUMB_STORE_NAME = 'attachment-thumbs';
export const THUMB_META_STORE = 'attachment-thumbs-lru';
// Bumped to 5: unified size-bounded attachment cache (drops the old thumbnail-only stores).
export const DB_VERSION = 5;
