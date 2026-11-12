import {Fragment, type RefObject} from "react";
import {useTranslation} from "react-i18next";
import {sameDay} from "@/shared/lib/datetime.ts";
import {MessageBubble, type ChatMessageView} from "./MessageBubble.tsx";
import {dateLabel} from "./messageFormat.tsx";

/**
 * The scrollable message list: history-error banner, "show earlier", the windowed run of bubbles with
 * date separators + same-sender grouping, and the "↓ N new" jump-to-bottom button. Presentational —
 * the scroll refs, the scroll effects, and the windowing live in ChatWindow / useWindowedHistory and
 * are threaded in. Extracted from ChatWindow verbatim.
 */
export function MessageList({
    listRef,
    contentRef,
    bottomRef,
    onScroll,
    shown,
    unencryptedIds,
    peerLastReadId,
    outboxStatusById,
    isGroup,
    authorName,
    loadingHistory,
    historyError,
    onReloadHistory,
    hasEarlier,
    showEarlier,
    loadingOlder,
    unseenBelow,
    onJumpToBottom,
    onResolveAttachment,
    onDownloadAttachment,
    onDeleteMessage,
    onForwardMessage,
    onRetryMessage,
    onDiscardMessage,
}: {
    listRef: RefObject<HTMLDivElement | null>;
    contentRef: RefObject<HTMLDivElement | null>;
    bottomRef: RefObject<HTMLDivElement | null>;
    onScroll: () => void;
    shown: ChatMessageView[];
    unencryptedIds?: ReadonlySet<string>;   // came in the clear into a secret chat → marked on the bubble
    peerLastReadId: string;
    outboxStatusById?: Record<string, string>;
    isGroup?: boolean;
    authorName: (id?: string) => string | undefined;
    loadingHistory?: boolean;
    historyError?: boolean;
    onReloadHistory?: () => void;
    hasEarlier: boolean;
    showEarlier: () => void;
    loadingOlder: boolean;
    unseenBelow: number;
    onJumpToBottom: () => void;
    onResolveAttachment?: (attachmentId: string) => Promise<string | null>;
    onDownloadAttachment?: (attachmentId: string, meta?: {fileName?: string; contentType?: string}) => void;
    onDeleteMessage?: (id: string, attachmentId?: string) => void;
    onForwardMessage?: (text: string) => void;
    onRetryMessage?: (id: string) => void;
    onDiscardMessage?: (id: string) => void;
}) {
    const {t} = useTranslation();
    return (
        <>
            <div ref={listRef} onScroll={onScroll}
                 className="flex-1 overflow-y-auto overscroll-contain p-4 bg-gray-300">
                <div ref={contentRef}>
                {/* History failed to load (server error) — show it, don't render a silent empty chat. */}
                {historyError && (
                    <div className="mx-auto my-2 max-w-xs text-center text-sm bg-red-100 text-red-800 rounded-lg px-3 py-2">
                        {t("chat.historyLoadError", {defaultValue: "Couldn't load messages"})}
                        {onReloadHistory && (
                            <button onClick={() => onReloadHistory()} className="ml-2 underline font-medium">
                                {t("chat.retry")}
                            </button>
                        )}
                    </div>
                )}
                {/* Loading the SELECTED chat's history: show a spinner, never the previous chat's rows
                    (the header already shows the new contact — stale rows under it were disorienting). */}
                {loadingHistory ? (
                    <div className="flex items-center justify-center py-10" role="status" aria-live="polite">
                        <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-teal-700 border-t-transparent" aria-hidden="true" />
                        <span className="sr-only">{t("loading")}</span>
                    </div>
                ) : (<>
                {hasEarlier && (
                    <button
                        onClick={showEarlier}
                        disabled={loadingOlder}
                        className="mx-auto block text-sm text-teal-800 hover:underline py-1 disabled:opacity-50"
                    >
                        {loadingOlder ? t("loading") : t("chat.loadEarlier")}
                    </button>
                )}
                {shown.map((msg, idx) => {
                    const prev = idx > 0 ? shown[idx - 1] : null;
                    const showDate = !prev || !sameDay(prev.createdAt, msg.createdAt);
                    // Tighten spacing for a run of consecutive same-sender messages (within 5 min).
                    const grouped = !!prev && !showDate && prev.fromMe === msg.fromMe
                        && (msg.createdAt - prev.createdAt) < 5 * 60 * 1000;
                    const bubbleMt = showDate ? "mt-0" : grouped ? "mt-0.5" : "mt-3";
                    return (
                    <Fragment key={msg.id}>
                    {showDate && (
                        <div className="text-center my-2">
                            <span className="inline-block text-[11px] text-gray-600 bg-white/70 rounded-full px-3 py-0.5">
                                {dateLabel(msg.createdAt, t)}
                            </span>
                        </div>
                    )}
                    <MessageBubble
                        msg={msg}
                        unencrypted={unencryptedIds?.has(msg.id)}
                        bubbleMt={bubbleMt}
                        peerLastReadId={peerLastReadId}
                        status={outboxStatusById?.[msg.id]}
                        isGroup={isGroup}
                        authorName={isGroup && !msg.fromMe ? authorName(msg.from) : undefined}
                        onResolveAttachment={onResolveAttachment}
                        onDownloadAttachment={onDownloadAttachment}
                        onDeleteMessage={onDeleteMessage}
                        onForwardMessage={onForwardMessage}
                        onRetryMessage={onRetryMessage}
                        onDiscardMessage={onDiscardMessage}
                    />
                    </Fragment>
                    );
                })}
                </>)}
                <div ref={bottomRef}/>
                </div>
            </div>

            {/* Jump-to-bottom when scrolled up and new messages arrived below */}
            {unseenBelow > 0 && (
                <button
                    onClick={onJumpToBottom}
                    className="absolute right-4 bottom-24 z-20 bg-teal-950 text-white text-xs rounded-full px-3 py-1.5 shadow-lg hover:bg-teal-900"
                >
                    ↓ {unseenBelow}
                </button>
            )}
        </>
    );
}
