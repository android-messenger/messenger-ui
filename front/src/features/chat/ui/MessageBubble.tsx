import toast from "react-hot-toast";
import {useTranslation} from "react-i18next";
import {isUlid, ulidTimeMs} from "@/shared/ulid/ulid.ts";
import {formatLocalTime} from "@/shared/lib/datetime.ts";
import {AttachmentImage} from "./AttachmentImage.tsx";
import {AttachmentAudio} from "./AttachmentAudio.tsx";
import {AttachmentVideo} from "./AttachmentVideo.tsx";
import {linkify} from "./messageFormat.tsx";
import {isSecretEnvelope} from "@/features/e2ee/wire.ts";
import {secretStateKey, type SecretMsgState} from "@/features/e2ee/wire.ts";
import {MessageMenu, type MsgMenuItem} from "./MessageMenu.tsx";
import {CopyIcon, ForwardIcon, TrashIcon} from "./icons.tsx";

export interface ChatMessageView {
    id: string;
    text: string;
    fromMe: boolean;
    from?: string;   // author (senderId) — used to label the sender in a GROUP
    createdAt: number;
    kind?: string;
    meta?: Record<string, string>;
    secret?: boolean;   // E2EE message → show a 🔒 marker
    unsaved?: boolean;  // secret text shown but not stored on this device
}

/**
 * One message bubble: attachment (image thumbnail / download) or linkified text, the local time, and
 * — for my own messages — the delivery/read indicator (🕐 sending, ⚠ failed + retry/discard, ✓ sent,
 * ✓✓ read) plus a delete button. Extracted from ChatWindow VERBATIM, including the ULID-guarded ✓✓
 * rule (a temp nanoid id must not be compared against a ULID read boundary — that gave false ✓✓).
 */
export function MessageBubble({
    msg,
    unencrypted,
    bubbleMt,
    peerLastReadId,
    status,
    isGroup,
    authorName,
    onResolveAttachment,
    onDownloadAttachment,
    onDeleteMessage,
    onForwardMessage,
    onRetryMessage,
    onDiscardMessage,
}: {
    msg: ChatMessageView;
    unencrypted?: boolean;  // came in the clear into a secret chat
    bubbleMt: string;
    peerLastReadId: string;
    status?: string;
    isGroup?: boolean;      // GROUP: label the author on peers' bubbles + no ✓✓ (no read-by-N aggregate)
    authorName?: string;    // resolved display name of msg.from, for a peer's bubble in a group
    onResolveAttachment?: (attachmentId: string) => Promise<string | null>;
    onDownloadAttachment?: (attachmentId: string, meta?: {fileName?: string; contentType?: string}) => void;
    onDeleteMessage?: (id: string, attachmentId?: string) => void;
    onForwardMessage?: (text: string) => void;
    onRetryMessage?: (id: string) => void;
    onDiscardMessage?: (id: string) => void;
}) {
    const {t} = useTranslation();
    // Copy / forward apply to real TEXT only — not attachments, and not a secret message still showing
    // its raw envelope (undecrypted). A decrypted secret message copies/forwards its plaintext.
    // Copy / forward apply to real TEXT only — not attachments, not a raw (undecrypted) envelope, and not a
    // secret-state PLACEHOLDER ("🔒 unavailable", "🕗 expired", …), which is UI text, not message content.
    const SECRET_PLACEHOLDERS: SecretMsgState[] = ["decrypting", "pending", "expired", "lost", "unavailable"];
    const isPlaceholder = SECRET_PLACEHOLDERS.some((s) => msg.text === t(secretStateKey(s)));
    const canCopyForward = msg.kind !== "attachment" && !isSecretEnvelope(msg.text) && !!msg.text.trim() && !isPlaceholder;
    const copyText = () => {
        navigator.clipboard?.writeText(msg.text)
            .then(() => toast.success(t("chat.copied", {defaultValue: "Copied"})))
            .catch(() => toast.error(t("chat.copyError", {defaultValue: "Couldn't copy"})));
    };
    // Actions menu (⋯) — Copy / Forward / Delete. Delete only for an actually-SENT own message (an un-sent
    // one is discarded via the inline status control below, not server-deleted).
    const menuItems: MsgMenuItem[] = [];
    if (canCopyForward) {
        menuItems.push({key: "copy", icon: <CopyIcon />, label: t("chat.copy", {defaultValue: "Copy"}), onClick: copyText});
        if (onForwardMessage) {
            menuItems.push({key: "forward", icon: <ForwardIcon />, label: t("chat.forward", {defaultValue: "Forward"}), onClick: () => onForwardMessage(msg.text)});
        }
    }
    if (onDeleteMessage && msg.fromMe && !status) {
        menuItems.push({
            key: "delete", icon: <TrashIcon />, danger: true,
            label: t("chat.deleteMessage"), ariaLabel: t("chat.deleteMessage"),
            onClick: () => onDeleteMessage(msg.id, msg.meta?.attachmentId),
        });
    }
    return (
        <div
            className={`group relative ${bubbleMt} max-w-xs py-2 pl-4 ${menuItems.length ? "pr-9" : "pr-4"} rounded-lg text-sm whitespace-pre-wrap break-words ${
                msg.fromMe
                    ? "ml-auto bg-teal-950 text-white rounded-br-none"
                    : "mr-auto bg-white text-teal-950 rounded-bl-none"
            }`}
        >
            {/* Per-message actions (⋯) at the top-right corner (clear of the group author label on the left). */}
            {menuItems.length > 0 && (
                <div className="absolute top-1 right-1">
                    <MessageMenu items={menuItems} align="right" />
                </div>
            )}
            {/* Author label — only on a peer's bubble in a GROUP (in 1:1 the sender is obvious). */}
            {isGroup && !msg.fromMe && authorName && (
                <div className="text-[11px] font-semibold text-teal-700 mb-0.5">{authorName}</div>
            )}
            {msg.kind === "attachment" ? (
                (msg.meta?.contentType ?? "").startsWith("image/") ? (
                    <AttachmentImage
                        attachmentId={msg.meta?.attachmentId ?? ""}
                        fileName={msg.meta?.fileName ?? msg.text ?? "imagen"}
                        resolveUrl={onResolveAttachment}
                    />
                ) : (msg.meta?.contentType ?? "").startsWith("audio/") ? (
                    <AttachmentAudio
                        attachmentId={msg.meta?.attachmentId ?? ""}
                        fileName={msg.meta?.fileName ?? msg.text ?? "audio"}
                        resolveUrl={onResolveAttachment}
                    />
                ) : (msg.meta?.contentType ?? "").startsWith("video/") ? (
                    <AttachmentVideo
                        attachmentId={msg.meta?.attachmentId ?? ""}
                        fileName={msg.meta?.fileName ?? msg.text ?? "video"}
                        resolveUrl={onResolveAttachment}
                    />
                ) : (
                    <button
                        onClick={() => onDownloadAttachment?.(msg.meta?.attachmentId ?? "", {fileName: msg.meta?.fileName, contentType: msg.meta?.contentType})}
                        className="underline decoration-dotted break-all text-left"
                        title="Descargar"
                    >
                        📎 {msg.meta?.fileName ?? msg.text ?? "archivo"}
                    </button>
                )
            ) : isSecretEnvelope(msg.text) ? (
                // A secret message whose plaintext hasn't been patched in yet (the decrypt runs a beat
                // after history loads): show a placeholder, NEVER the raw E2EE envelope — that was the
                // "encrypted text flashes for a few seconds" on open.
                <span className="italic opacity-60">{t("chat.decrypting")}</span>
            ) : (
                linkify(msg.text)
            )}
            {msg.secret && (
                <span className="ml-1 text-[10px] align-bottom opacity-70" title={t("chat.secretOn")}>🔒</span>
            )}
            {msg.unsaved && (
                <span className="ml-1 text-[10px] align-bottom font-medium text-amber-700" data-testid="not-saved" title={t("chat.notSavedTitle")}>
                    ⚠ {t("chat.notSaved")}
                </span>
            )}
            {unencrypted && !msg.secret && (
                <span className="ml-1 text-[10px] align-bottom font-medium text-red-700" data-testid="not-encrypted">
                    🔓 {t("chat.notEncrypted")}
                </span>
            )}
            <span className="ml-2 text-[10px] align-bottom opacity-50">{formatLocalTime(msg.createdAt)}</span>
            {msg.fromMe && (() => {
                if (status === "failed") {
                    return (
                        <span className="ml-2 text-[10px] align-bottom">
                            <span title={t("chat.failed")} className="text-red-300">⚠</span>
                            <button onClick={() => onRetryMessage?.(msg.id)} title={t("chat.retry")}
                                    aria-label={t("chat.retry")}
                                    className="ml-1 opacity-70 hover:opacity-100">↻</button>
                            <button onClick={() => onDiscardMessage?.(msg.id)} title={t("chat.discard")}
                                    aria-label={t("chat.discard")}
                                    className="ml-1 opacity-70 hover:opacity-100">🗑</button>
                        </span>
                    );
                }
                if (status === "pending" || status === "sending") {
                    return (
                        <span className="ml-2 text-[10px] align-bottom">
                            <span title={t("chat.sending")} className="opacity-70">🕐</span>
                            {/* Discard an un-sent message: drop it from the send queue (not a server
                                delete — it was never accepted). */}
                            {onDiscardMessage && (
                                <button onClick={() => onDiscardMessage(msg.id)} title={t("chat.discard")}
                                        aria-label={t("chat.discard")}
                                        className="ml-1 opacity-70 hover:opacity-100">🗑</button>
                            )}
                        </span>
                    );
                }
                // Per-message read state: read iff this message's id is at/below the peer's read
                // boundary. BOTH sides must be server ULIDs for the string compare to be chronological.
                // An optimistic message not yet reconciled by CHAT_ACK still carries its temporary nanoid
                // id — comparing that against a ULID boundary is meaningless (nanoid's first char lands on
                // either side of a ULID's at random), which produced intermittent false ✓✓. Guard with
                // isUlid: no server id == not yet stored == cannot be read.
                // Read iff the peer's read boundary (a server ULID, ULID-guarded in the reducer) is
                // at/after this message. Prefer an EXACT id compare once the message has its server
                // ULID (reconciled by CHAT_ACK); before that — a just-sent optimistic echo still on its
                // temp client id — fall back to comparing the boundary ULID's embedded TIME against this
                // message's createdAt, so ✓✓ appears LIVE without waiting for a history reload to swap
                // the id. Groups have no peer read watermark (read-by-N is a later backend phase) → ✓ only.
                const isRead = !isGroup && isUlid(peerLastReadId) && (
                    isUlid(msg.id)
                        ? msg.id <= peerLastReadId
                        : msg.createdAt <= ulidTimeMs(peerLastReadId)
                );
                return (
                    <span className="ml-2 text-[10px] align-bottom opacity-70"
                          title={isRead ? t("chat.read") : t("chat.sent")}>
                        {isRead ? "✓✓" : "✓"}
                    </span>
                );
            })()}
            {/* Server-side "delete for me" lives in the ⋯ actions menu (built above) for a sent message. */}
        </div>
    );
}
