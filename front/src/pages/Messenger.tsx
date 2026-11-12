import {useCallback, useEffect, useRef, useState} from "react";
import {useNavigate, useSearchParams} from "react-router-dom";
import {useDispatch, useSelector} from "react-redux";
import {useTranslation} from "react-i18next";

import ChatList from "@/features/chat/ui/ChatList.tsx";
import ChatWindow from "@/features/chat/ui/ChatWindow.js";
import {ConnectionBanner} from "@/features/chat/ui/ConnectionBanner.tsx";
import {VaultWaitBanner} from "@/features/e2ee/ui/VaultWaitBanner.tsx";
import {NotificationPrompt} from "@/features/notifications";
import ConfirmModal from "@/shared/ui/ConfirmModal.jsx";
import VideoCall from "@/features/call/ui/VideoCall.tsx";
import {useChat} from "@/features/chat/hooks";
import {useOutboxRetry} from "@/features/chat/hooks/useOutboxRetry.ts";
import {useCallTimeout} from "@/features/call/hooks/useCallTimeout.ts";
import {useCallRingtone} from "@/features/call/hooks/useCallRingtone.ts";
import {LightboxProvider} from "@/features/chat/ui/Lightbox.tsx";
import {ForwardModal} from "@/features/chat/ui/ForwardModal.tsx";

const EMPTY_SECRET: Record<string, boolean> = {};   // stable ref → no re-render churn when there are no secret chats

import type {RootState, AppDispatch} from "@/store/store.ts";
import {outgoingCall, answerViaPush, acceptCall, localEnd, rejectCall} from "@/features/call/model/slices/callSlice";
import {parseCallDeepLink} from "@/features/call/model/callDeepLink.ts";
import {takeNativeAccept} from "@/features/call/model/nativeAccept.ts";
import {readPendingCall, clearPendingCall} from "@/features/call/model/pendingCall.ts";
import {CALL_TIMEOUT_MS} from "@/shared/config/webrtc";
import {useWebRTC} from "@/features/call/hooks/useWebRTC.ts";


export default function Messenger() {
    const navigate = useNavigate();
    const dispatch = useDispatch<AppDispatch>();
    const {t} = useTranslation();

    // Periodic outbox retry driver (ACK-timeout resend).
    useOutboxRetry();
    // End an unanswered outgoing call after a timeout.
    useCallTimeout();
    // Ring while a call is incoming/dialing.
    useCallRingtone();

    /* ======================
       WebRTC service
    ====================== */
    const {localStream, remoteStream} = useWebRTC(); // 🔥
    /* ======================
       Chat service
    ====================== */
    const chat = useChat();

    /* ======================
       Deep link from a push notification: /messenger-ui/?chat=<conversationId> opens that chat
       (the SW's notificationclick navigates here). Open it once, then strip the param so a later
       reload/back doesn't reopen it.
    ====================== */
    const [searchParams, setSearchParams] = useSearchParams();
    const openChat = chat.openChat;
    useEffect(() => {
        const chatParam = searchParams.get("chat");
        if (!chatParam) return;
        openChat(chatParam);
        const next = new URLSearchParams(searchParams);
        next.delete("chat");
        setSearchParams(next, {replace: true});
    }, [searchParams, openChat, setSearchParams]);

    // Deep link from an INCOMING-CALL push (SW notificationclick "Answer"):
    //   ?call=<conversationId>&caller=<callerUserId>
    // Open the conversation and tell the caller we are here (call:ready) — the original WebRTC offer is
    // stale by the time the app cold-starts, so the caller re-sends it. Nobody is called back. Then strip
    // the params. The address never says "already accepted": see features/call/model/nativeAccept.ts.
    // Once per link: the effect re-runs on every render while ?call= is still in the URL (openChat is a new
    // function each render), and each run used to send another call:ready — the caller then restarted ICE
    // once per call:ready, and an answer to an older offer never connected (seen with auto-accept, S1 §7.3).
    const handledCallLink = useRef<string | null>(null);
    useEffect(() => {
        const link = parseCallDeepLink(searchParams);
        if (!link) { handledCallLink.current = null; return; }
        const key = `${link.conversationId}|${link.peerId}`;
        if (handledCallLink.current === key) return;
        handledCallLink.current = key;
        openChat(link.conversationId);
        // Answer flow: tell the still-ringing caller "I'm here" so they re-send the offer and we show a
        // real INCOMING dialog. conversationId comes from the push (survives a cold start before getChats
        // loads). If no offer arrives, nothing happens (see callMiddleware answerViaPush: no callback).
        dispatch(answerViaPush({peerId: link.peerId, conversationId: link.conversationId, media: link.media, autoAccept: takeNativeAccept(link.peerId, link.conversationId)}));
        void clearPendingCall();   // the deep-link handled it — don't let the boot check re-fire
        const next = new URLSearchParams(searchParams);
        next.delete("call");
        next.delete("caller");
        next.delete("media");
        next.delete("accept");   // not read any more; an old link may still carry it
        setSearchParams(next, {replace: true});
    }, [searchParams, openChat, dispatch, setSearchParams]);

    // Pick up a STILL-RINGING call when the app is opened DIRECTLY (not via the notification): the SW
    // stored it from the call push; the original offer is gone, so re-run the answer flow. Once on mount.
    useEffect(() => {
        if (searchParams.get("call")) return;   // the deep-link effect owns that path
        let alive = true;
        void (async () => {
            const pc = await readPendingCall();
            if (!alive || !pc) return;
            void clearPendingCall();
            if (Date.now() - pc.at > CALL_TIMEOUT_MS) return;   // stale — the call has timed out
            openChat(pc.conversationId);
            dispatch(answerViaPush({peerId: pc.caller, conversationId: pc.conversationId, media: pc.media}));
        })();
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /* ======================
       Delete modal
    ====================== */
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    // Text of the message being forwarded (null = picker closed). The picker chooses a target chat.
    const [forwardText, setForwardText] = useState<string | null>(null);

    /* ======================
       Call status from Redux
    ====================== */
    const callStatus = useSelector((state: RootState) => state.call.status);

    /* ======================
       Derived
    ====================== */
    const peerContact = chat.selectedChat ?? null;
    const myName = useSelector((state: RootState) => state.user.name);
    // Which conversations are secret (E2EE) — to flag a secret-origin forward and mark secret targets.
    const secretChatIds = useSelector((state: RootState) => state.secretChats?.byId ?? EMPTY_SECRET);
    const isSecretChat = useCallback((id: string) => !!secretChatIds[id], [secretChatIds]);
    // Forward is initiated from the OPEN chat, so its secrecy is the source's secrecy.
    const forwardFromSecret = forwardText !== null && !!chat.selectedChatId && isSecretChat(chat.selectedChatId);

    // Stable callbacks so the memoized ChatList/ChatWindow don't re-render on unrelated state.
    const selectedCounterpartId = chat.selectedCounterpartId;
    const onLogout = useCallback(() => navigate("/logout"), [navigate]);
    const onOpenDeleteModal = useCallback(() => setShowDeleteModal(true), []);
    const onCall = useCallback(() => {
        // Call the counterpart's USER id (signaling recipient), not the conversationId.
        if (selectedCounterpartId) dispatch(outgoingCall({peerId: selectedCounterpartId, audioOnly: false}));
    }, [selectedCounterpartId, dispatch]);
    const onAudioCall = useCallback(() => {
        if (selectedCounterpartId) dispatch(outgoingCall({peerId: selectedCounterpartId, audioOnly: true}));
    }, [selectedCounterpartId, dispatch]);

    /* ======================
       Render
    ====================== */
    return (
        <LightboxProvider>
        <div className="relative h-dvh w-screen flex overflow-hidden safe-area-shell">
            <ConnectionBanner/>
            <VaultWaitBanner/>
            <NotificationPrompt/>
            {/* ===== Chat List ===== */}
            <ChatList
                chats={chat.filteredChats}
                openChat={chat.openChat}
                unreadChats={chat.unreadChats}
                search={chat.searchQuery}
                setSearch={chat.setSearchQuery}
                myName={myName}
                onLogout={onLogout}
            />

            {/* ===== Chat Window ===== */}
            <ChatWindow
                chat={chat.selectedChat}
                counterpartId={selectedCounterpartId}
                isGroup={chat.selectedIsGroup}
                messages={chat.messages}
                loadingHistory={chat.loadingHistory}
                historyError={chat.historyError}
                onReloadHistory={chat.reloadChatHistory}
                inputText={chat.messageInput}
                setInputText={chat.setMessageInput}
                sendMessage={chat.sendMessage}
                onTyping={chat.notifyTyping}
                onToggleBlock={chat.toggleBlock}
                blocked={chat.selectedBlocked}
                blockedByMe={chat.selectedBlockedByMe}
                blockedByPeer={chat.selectedBlockedByPeer}
                onDeleteMessage={chat.deleteMessage}
                onForwardMessage={setForwardText}
                onSendAttachment={chat.sendAttachment}
                uploadProgress={chat.uploadProgress}
                onDownloadAttachment={chat.downloadAttachment}
                onResolveAttachment={chat.getAttachmentUrl}
                outboxStatusById={chat.outboxStatusById}
                onRetryMessage={chat.retryMessage}
                onDiscardMessage={chat.discardMessage}
                onDeleteChat={onOpenDeleteModal}
                onCall={onCall}
                onAudioCall={onAudioCall}
            />

            {/* ===== Forward picker ===== */}
            {forwardText !== null && (
                <ForwardModal
                    chats={chat.contacts}
                    preview={forwardText}
                    sourceSecret={forwardFromSecret}
                    isSecretTarget={isSecretChat}
                    onPick={(targetChatId) => { chat.forwardMessage(targetChatId, forwardText); setForwardText(null); }}
                    onClose={() => setForwardText(null)}
                />
            )}

            {/* ===== Video Call ===== */}
            {callStatus !== "idle" && (
                <VideoCall
                    localStream={localStream}
                    remoteStream={remoteStream}
                    onHangUp={() => dispatch(localEnd())}
                    acceptCall={() => dispatch(acceptCall())}
                    rejectCall={() => dispatch(rejectCall())}
                />
            )}

            {/* ===== Delete Confirmation Modal ===== */}
            {showDeleteModal && peerContact && (
                <ConfirmModal
                    title={t("chat.deleteChatTitle")}
                    message={t("chat.deleteChatConfirm", {name: peerContact.name})}
                    confirmText={t("chat.delete")}
                    cancelText={t("common.cancel")}
                    onCancel={() => setShowDeleteModal(false)}
                    onConfirm={async () => {
                        await chat.deleteChat();
                        setShowDeleteModal(false);
                    }}
                />
            )}
        </div>
        </LightboxProvider>
    );
}