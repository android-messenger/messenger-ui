import {useCallback, useRef, useState} from "react";
import {useDispatch, useSelector} from "react-redux";
import toast from "react-hot-toast";
import {useTranslation} from "react-i18next";

import type {AppDispatch, RootState} from "@/store/store";
import {chatMessagesService} from "@/features/chat/model/services/chatMessages.service.ts";
import {buildTypingIn} from "@/features/chat/model/schema/wireMessage.schema.ts";
import {loadDraft, saveDraft, clearDraft} from "@/features/chat/model/drafts.ts";
import {logger} from "@/shared/logger/logger.ts";

type ComposerSummary = {counterpartId: string; orderId?: string} | null | undefined;

/**
 * Message composer state + actions, extracted from useChat: the draft input, sending a message
 * (validate → enqueue via the outbox service → clear the input), and the throttled "I'm typing"
 * notifier. Behavior preserved verbatim, including the no-summary guard that surfaces an error toast
 * instead of failing silently.
 */
const EMPTY_SECRET: Record<string, true> = {};   // stable ref → no re-render churn when there are no secret chats

export function useMessageComposer(params: {
    selectedChatId: string | null;
    myId: string;
    getSummary: (chatId: string) => ComposerSummary;
}) {
    const {selectedChatId, myId, getSummary} = params;
    const dispatch = useDispatch<AppDispatch>();
    const {t} = useTranslation();
    const secretIds = useSelector((s: RootState) => s.secretChats?.byId ?? EMPTY_SECRET);
    const isSecretChat = useCallback((id: string) => !!secretIds[id], [secretIds]);
    // Seed from the persisted draft for the initially-selected chat (e.g. a deep-link open).
    const [messageInput, setMessageInputRaw] = useState(() => selectedChatId ? loadDraft(selectedChatId) : "");

    // Restore the per-chat draft when the open chat changes — during render (adjust-state-on-change),
    // not an effect. A single messageInput used to leak one chat's unsent text into the next chat.
    const [draftChat, setDraftChat] = useState(selectedChatId);
    if (selectedChatId !== draftChat) {
        setDraftChat(selectedChatId);
        setMessageInputRaw(selectedChatId ? loadDraft(selectedChatId) : "");
    }

    // Public setter also persists the draft under the CURRENT chat (so switching chats can't misfile it).
    // A secret chat's draft stays in memory only — never in localStorage.
    const setMessageInput = useCallback((text: string) => {
        setMessageInputRaw(text);
        if (selectedChatId) saveDraft(selectedChatId, text, {persist: !isSecretChat(selectedChatId)});
    }, [selectedChatId, isSecretChat]);

    const sendMessage = useCallback((text: string) => {
        if (!selectedChatId || !text.trim()) return;
        const summary = getSummary(selectedChatId);
        if (!summary) {
            // Don't fail silently: if we can't resolve the conversation we can't send. Log it and
            // tell the user instead of the click doing nothing.
            logger.warn("sendMessage: no summary for selected chat — cannot send", {selectedChatId});
            toast.error(t("chat.msgSendError", {defaultValue: "Couldn't send — reopen the chat"}));
            return;
        }
        setMessageInputRaw("");
        clearDraft(selectedChatId);
        const secret = isSecretChat(selectedChatId);
        void chatMessagesService.enqueueChatMessage(
            dispatch, text, myId, selectedChatId, summary.counterpartId, summary.orderId, secret
        );
        // A new message is naturally "not read yet": its createdAt is above the peer's read
        // watermark, so it renders ✓ until a READ_OUT advances the watermark past it. No global reset.
    }, [selectedChatId, getSummary, myId, dispatch, t, isSecretChat]);

    // Forward a message's TEXT into ANOTHER chat: enqueue it there as a fresh message (same outbox path
    // as a normal send), honoring the TARGET chat's secret setting. Text only — attachments would need
    // re-upload/re-encryption (deferred). The target may be any conversation, not the open one.
    const forwardMessage = useCallback((targetChatId: string, text: string) => {
        if (!targetChatId || !text.trim()) return;
        const summary = getSummary(targetChatId);
        if (!summary) {
            logger.warn("forwardMessage: no summary for target chat", {targetChatId});
            toast.error(t("chat.msgSendError", {defaultValue: "Couldn't send — reopen the chat"}));
            return;
        }
        const secret = isSecretChat(targetChatId);
        void chatMessagesService.enqueueChatMessage(
            dispatch, text, myId, targetChatId, summary.counterpartId, summary.orderId, secret
        );
        toast.success(t("chat.forwarded", {defaultValue: "Forwarded"}));
    }, [getSummary, myId, dispatch, t, isSecretChat]);

    // Throttled "I'm typing" notifier (TYPING_IN → peer's TYPING_OUT). Called on input change.
    const lastTypingRef = useRef(0);
    const notifyTyping = useCallback(() => {
        if (!selectedChatId) return;
        const now = Date.now();
        if (now - lastTypingRef.current < 2500) return;
        lastTypingRef.current = now;
        const s = getSummary(selectedChatId);
        if (s) dispatch({type: "ws/send", payload: buildTypingIn(selectedChatId, s.counterpartId)});
    }, [selectedChatId, getSummary, dispatch]);

    return {messageInput, setMessageInput, sendMessage, forwardMessage, notifyTyping};
}
