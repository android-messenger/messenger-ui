import {memo, useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import {useDispatch, useSelector} from "react-redux";
import {useTranslation} from "react-i18next";
import type {AppDispatch, RootState} from "@/store/store";
import type {Contact} from "@/entities/contact";
import {setSelectedChatId} from "@/features/chat/model/slices/chatUiSlice.ts";
import {unencryptedAfterSecret} from "@/features/chat/model/unencrypted.ts";
import {markSecret, unmarkSecret} from "@/features/chat/model/slices/secretChatsSlice.ts";
import {SafetyNumberModal} from "@/features/e2ee/ui/SafetyNumberModal.tsx";
import {KeyChangeLine, secretAvailable} from "@/features/e2ee";
import toast from "react-hot-toast";
import {useGetPresenceStatusQuery} from "@/features/chat/rest/chatApi.ts";
import {fmtLastSeen} from "@/features/chat/model/lastSeen.ts";
import {useWindowedHistory} from "@/features/chat/hooks/useWindowedHistory.ts";
import {useGroupAuthorNames} from "@/features/chat/hooks/useGroupAuthorNames.ts";
import {useGroupRoster, RosterPanel} from "@/features/groups";
import {ChatHeader} from "./ChatHeader.tsx";
import {Composer} from "./Composer.tsx";
import {MessageList} from "./MessageList.tsx";
import type {ChatMessageView} from "./MessageBubble.tsx";

interface ChatWindowProps {
    chat: Contact | null;
    counterpartId?: string | null;
    isGroup?: boolean;
    messages: ChatMessageView[];
    loadingHistory?: boolean;
    historyError?: boolean;
    onReloadHistory?: () => void;
    inputText: string;
    setInputText: (value: string) => void;
    sendMessage: (text: string) => void;
    onDeleteChat: () => void;
    onCall: () => void;
    onAudioCall: () => void;
    onTyping?: () => void;
    onToggleBlock?: () => void;
    blocked?: boolean;
    blockedByMe?: boolean;
    blockedByPeer?: boolean;
    onDeleteMessage?: (id: string, attachmentId?: string) => void;
    onForwardMessage?: (text: string) => void;
    onSendAttachment?: (file: File) => void;
    uploadProgress?: number | null;
    onDownloadAttachment?: (attachmentId: string) => void;
    onResolveAttachment?: (attachmentId: string) => Promise<string | null>;
    outboxStatusById?: Record<string, string>;
    onRetryMessage?: (id: string) => void;
    onDiscardMessage?: (id: string) => void;
}

function ChatWindow({
                        chat,
                        counterpartId,
                        isGroup,
                        messages,
                        loadingHistory,
                        historyError,
                        onReloadHistory,
                        inputText,
                        setInputText,
                        sendMessage,
                        onDeleteChat,
                        onCall,
                        onAudioCall,
                        onTyping,
                        onToggleBlock,
                        blocked,
                        blockedByMe,
                        blockedByPeer,
                        onDeleteMessage,
                        onForwardMessage,
                        onSendAttachment,
                        uploadProgress,
                        onDownloadAttachment,
                        onResolveAttachment,
                        outboxStatusById,
                        onRetryMessage,
                        onDiscardMessage,
                    }: ChatWindowProps) {
    const {t} = useTranslation();
    const dispatch = useDispatch<AppDispatch>();

    // "Last seen" for an OFFLINE peer: fetch only while they're offline (online-ness comes live from
    // the presence slice; the timestamp only from this REST read). refetchOnMountOrArgChange gets a
    // fresh value each time the header re-opens or the peer transitions offline. Absent/legacy backend
    // (404) or a null timestamp → fmtLastSeen returns null → the header shows a plain "offline".
    const {data: peerPresence} = useGetPresenceStatusQuery(counterpartId ?? "", {
        skip: !counterpartId || !!chat?.online,
        refetchOnMountOrArgChange: true,
    });
    const lastSeenText = !chat?.online ? fmtLastSeen(peerPresence?.lastSeen ?? null, t) : null;

    const selectedChatId = useSelector(
        (state: RootState) => state.chatUi.selectedChatId
    );
    // The message id (server ULID) the peer has read up to. Server-driven: the history response
    // (HistoryPage.peerLastReadId) and the live READ_OUT frame (its correlationId) both feed it via
    // chatUi. A sent message shows ✓✓ iff its id <= this (ULID lexicographic == chronological).
    const peerLastReadId = useSelector((state: RootState) =>
        selectedChatId ? (state.chatUi.peerLastReadIdByChat[selectedChatId] ?? "") : ""
    );
    const secret = useSelector((state: RootState) =>
        !!(selectedChatId && state.secretChats.byId[selectedChatId])
    );
    const myId = useSelector((state: RootState) => state.user.id);
    const [safetyOpen, setSafetyOpen] = useState(false);
    const peerTyping = useSelector((state: RootState) =>
        selectedChatId ? !!state.chatUi.typingByChat[selectedChatId] : false
    );

    const bottomRef = useRef<HTMLDivElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);
    // Track whether the user is at the bottom, so a new message doesn't yank them up out of the
    // history they're reading; unseenBelow drives the "↓ N new" jump button.
    const atBottomRef = useRef(true);
    const prevLenRef = useRef(messages.length);
    const prevLastIdRef = useRef<string | null>(null);
    // Set true when a chat opens; a layout effect lands the view at the newest message as soon as the
    // opened chat's rows actually render (history loads async, so scrolling on open-alone lands on an
    // empty/stale list — the "stuck in the middle" bug).
    const pendingBottomRef = useRef(true);
    const [unseenBelow, setUnseenBelow] = useState(0);

    // Reset the "↓ N new" counter when the open chat changes — during render (React's adjust-state-on-
    // change), not in the open-chat effect below, so it can't cascade an extra render.
    const [prevChatId, setPrevChatId] = useState(selectedChatId);
    if (selectedChatId !== prevChatId) {
        setPrevChatId(selectedChatId);
        setUnseenBelow(0);
    }

    const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
        bottomRef.current?.scrollIntoView({behavior});
        atBottomRef.current = true;
        setUnseenBelow(0);
    };
    const onListScroll = () => {
        const el = listRef.current;
        const atBottom = el ? el.scrollHeight - el.scrollTop - el.clientHeight < 120 : true;
        atBottomRef.current = atBottom;
        // A genuine user scroll away from the bottom ends the "landing" state, so late-loading
        // attachments (images fetch→blob, video posters) stop re-pinning the view for them.
        if (!atBottom) pendingBottomRef.current = false;
        if (atBottom && unseenBelow) setUnseenBelow(0);
    };

    // Windowed history + "show earlier" (registers the window-reset + anchor-restore effects; called
    // BEFORE this component's own scroll effects so their commit order is unchanged). GROUP author-name
    // resolver (no-op for 1:1).
    const {shown, hasEarlier, showEarlier, loadingOlder} = useWindowedHistory(messages, selectedChatId, listRef);
    // Messages that came in the clear after the chat had become secret — over the whole loaded history,
    // not only the shown window.
    const unencryptedIds = useMemo(() => unencryptedAfterSecret(messages), [messages]);
    const authorName = useGroupAuthorNames(messages, !!isGroup);

    // GROUP roster (member/online counts, name resolver, self-heal refetch) + who's typing (by name).
    const {memberCount, onlineCount, memberIds, nameOf: memberNameOf, refetch: refetchRoster} =
        useGroupRoster(selectedChatId, !!isGroup);
    const typingUserId = useSelector((state: RootState) =>
        selectedChatId ? (state.chatUi.typingUserByChat[selectedChatId] ?? "") : ""
    );
    const typingName = isGroup && typingUserId ? memberNameOf(typingUserId) : undefined;
    const [rosterOpen, setRosterOpen] = useState(false);

    // Opening a chat: reset trackers, arm the "land at bottom" flag, focus the composer (wide screens
    // only — don't pop the mobile keyboard on every open). LAYOUT effect (before paint) + defined
    // BEFORE the landing effect below, so pendingBottomRef is set before that effect reads it.
    useLayoutEffect(() => {
        atBottomRef.current = true;
        pendingBottomRef.current = true;
        if (typeof window !== "undefined" && window.matchMedia?.("(min-width: 640px)").matches) {
            inputRef.current?.focus();
        }
    }, [selectedChatId]);

    // Land at the newest message once the opened chat's rows are present. Instant (scrollTop), not a
    // smooth animation that a re-render can interrupt. Waits for shown.length > 0 so an async history
    // load lands correctly instead of leaving the view mid-list. A rAF re-assert catches late layout
    // (e.g. images gaining height) so the view doesn't drift off the bottom right after opening.
    useLayoutEffect(() => {
        if (!pendingBottomRef.current || shown.length === 0) return;
        // Re-pin to the newest message across a short post-open window. A single scrollTop assignment is
        // not enough: posters/images, fonts and late reflow change the content height AFTER the first
        // paint, and (device-dependent) neither the ResizeObserver nor a lone rAF always catches it — so
        // the view strands mid-list ("chat doesn't scroll to the bottom on open"). Each pin is guarded by
        // pendingBottomRef, which onListScroll clears the instant the user scrolls up — so this never
        // fights someone reading history. Instant (scrollTop), never a smooth animation a re-render breaks.
        const pin = () => {
            const e = listRef.current;
            if (e && pendingBottomRef.current) { e.scrollTop = e.scrollHeight; atBottomRef.current = true; }
        };
        pin();
        const raf = requestAnimationFrame(pin);
        const timers = [150, 400, 800].map((ms) => setTimeout(pin, ms));
        return () => { cancelAnimationFrame(raf); timers.forEach(clearTimeout); };
    }, [selectedChatId, shown.length]);

    // Keep the view pinned to the newest message while we're at the bottom, even as content grows
    // AFTER paint — image attachments fetch + decode async and gain height later, which otherwise
    // pushes the last message up and strands the view mid-list ("scroll breaks after images load").
    // A ResizeObserver on the content re-pins to bottom on any such growth, but ONLY while we're at
    // the bottom (or still landing after open) — it never yanks a user who has scrolled up to read.
    useEffect(() => {
        const content = contentRef.current;
        const el = listRef.current;
        if (!content || !el || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(() => {
            if (atBottomRef.current || pendingBottomRef.current) el.scrollTop = el.scrollHeight;
        });
        ro.observe(content);
        return () => ro.disconnect();
    }, []);

    // Follow to the bottom / count "unseen" ONLY when a message is APPENDED (newest id changes) —
    // never when older messages are PREPENDED (scroll-up load grows length but the last id is same),
    // which must not yank the view or inflate the "↓ N new" badge.
    const lastMessageId = messages.length ? messages[messages.length - 1].id : null;
    useEffect(() => {
        const grew = messages.length - prevLenRef.current;
        const appended = lastMessageId !== prevLastIdRef.current;
        prevLenRef.current = messages.length;
        prevLastIdRef.current = lastMessageId;
        if (!appended) return;                       // prepend (older page) → leave scroll untouched
        if (atBottomRef.current) {
            bottomRef.current?.scrollIntoView({behavior: "smooth"});
            setUnseenBelow(0);
        } else if (grew > 0) {
            setUnseenBelow((n) => n + grew);
        }
    }, [lastMessageId, messages.length]);

    // Group roster self-heal: the best-effort MEMBER_JOINED/LEFT events are missed while offline, so
    // a message from a sender not in the cached roster means our roster is stale — refetch it (the
    // contract's "never infer membership from a message; re-fetch instead").
    useEffect(() => {
        if (!isGroup || memberIds.length === 0) return;
        const roster = new Set(memberIds);
        if (messages.some((m) => !m.fromMe && m.from && !roster.has(m.from))) refetchRoster();
    }, [isGroup, memberIds, messages, refetchRoster]);

    // Open the window only when the conversation is actually in the list. Guards against a dangling
    // selectedChatId (e.g. a soft-deleted chat dropped from getChats on refetch) rendering an empty
    // window with no counterpart name and a dead composer.
    const isChatOpen = !!selectedChatId && !!chat;

    return (
        <main
            className={`relative h-full flex flex-col w-full overflow-hidden ${
                !isChatOpen ? "hidden" : "flex"
            }`}
        >
            <ChatHeader
                chat={chat}
                isGroup={isGroup}
                memberCount={memberCount}
                onlineCount={onlineCount}
                typingName={typingName}
                onOpenRoster={() => setRosterOpen(true)}
                peerTyping={peerTyping}
                lastSeenText={lastSeenText}
                blockedByMe={blockedByMe}
                onBack={() => dispatch(setSelectedChatId(null))}
                onCall={onCall}
                onAudioCall={onAudioCall}
                onToggleBlock={onToggleBlock}
                onDeleteChat={onDeleteChat}
                secret={secret}
                // The user switches the mode both ways at will; each switch is confirmed, so a slip of the
                // finger does not send the next message in the clear.
                onToggleSecret={!isGroup && selectedChatId
                    ? () => {
                        if (secret) { if (window.confirm(t("chat.secretDisableConfirm"))) dispatch(unmarkSecret(selectedChatId)); }
                        // A browser has no keys: the mode is not turned on there, the user is told where it works.
                        else if (!secretAvailable()) toast.error(t("chat.appOnly"));
                        else if (window.confirm(t("chat.secretEnableConfirm"))) dispatch(markSecret(selectedChatId));
                    }
                    : undefined}
                onOpenSafety={counterpartId ? () => setSafetyOpen(true) : undefined}
            />

            {secret && counterpartId && (
                <KeyChangeLine peerUserId={counterpartId} peerName={chat?.name ?? counterpartId} onVerify={() => setSafetyOpen(true)}/>
            )}

            {safetyOpen && counterpartId && myId && (
                <SafetyNumberModal
                    peerUserId={counterpartId}
                    peerName={chat?.name ?? counterpartId}
                    onClose={() => setSafetyOpen(false)}
                />
            )}

            <MessageList
                listRef={listRef}
                contentRef={contentRef}
                bottomRef={bottomRef}
                onScroll={onListScroll}
                shown={shown}
                unencryptedIds={unencryptedIds}
                peerLastReadId={peerLastReadId}
                outboxStatusById={outboxStatusById}
                isGroup={isGroup}
                authorName={authorName}
                loadingHistory={loadingHistory}
                historyError={historyError}
                onReloadHistory={onReloadHistory}
                hasEarlier={hasEarlier}
                showEarlier={showEarlier}
                loadingOlder={loadingOlder}
                unseenBelow={unseenBelow}
                onJumpToBottom={() => scrollToBottom()}
                onResolveAttachment={onResolveAttachment}
                onDownloadAttachment={onDownloadAttachment}
                onDeleteMessage={onDeleteMessage}
                onForwardMessage={onForwardMessage}
                onRetryMessage={onRetryMessage}
                onDiscardMessage={onDiscardMessage}
            />

            <Composer
                inputRef={inputRef}
                inputText={inputText}
                setInputText={setInputText}
                sendMessage={sendMessage}
                onTyping={onTyping}
                onSendAttachment={onSendAttachment}
                uploadProgress={uploadProgress}
                blocked={blocked}
                blockedByPeer={blockedByPeer}
            />

            {isGroup && rosterOpen && selectedChatId && (
                <RosterPanel
                    groupId={selectedChatId}
                    groupName={chat?.name ?? ""}
                    memberIds={memberIds}
                    nameOf={memberNameOf}
                    onClose={() => setRosterOpen(false)}
                />
            )}
        </main>
    );
}

// Memoized so typing in the input / presence ticks (which re-render <Messenger>) don't re-render
// the whole window unless its own props change. Relies on Messenger passing memoized callbacks.
export default memo(ChatWindow);
