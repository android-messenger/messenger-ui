import {useCallback, useMemo} from "react";
import toast from "react-hot-toast";
import {useTranslation} from "react-i18next";

import {isUlid} from "@/shared/ulid/ulid.ts";
import {useBlockChatMutation, useUnblockChatMutation, useDeleteMessageMutation} from "@/features/chat/rest/chatApi.ts";
import {deleteAttachmentBlob} from "@/features/chat/db/db.ts";

type BlockSummary = {blocked?: boolean; blockedByMe?: boolean; blockedByPeer?: boolean} | null | undefined;

/**
 * Moderation for the open conversation (block/unblock + delete-message), extracted from useChat.
 * Owns the derived block flags and the two mutation-driven actions with their toasts and 409
 * ("message frozen") handling. Behavior preserved verbatim.
 */
export function useChatModeration(params: {
    selectedChatId: string | null;
    getSummary: (chatId: string) => BlockSummary;
}) {
    const {selectedChatId, getSummary} = params;
    const {t} = useTranslation();
    const [blockChat] = useBlockChatMutation();
    const [unblockChat] = useUnblockChatMutation();
    const [deleteMessageMut] = useDeleteMessageMutation();

    const selectedBlocked = useMemo(
        () => (selectedChatId ? getSummary(selectedChatId)?.blocked ?? false : false),
        [selectedChatId, getSummary]);
    const selectedBlockedByMe = useMemo(
        () => (selectedChatId ? getSummary(selectedChatId)?.blockedByMe ?? false : false),
        [selectedChatId, getSummary]);
    const selectedBlockedByPeer = useMemo(
        () => (selectedChatId ? getSummary(selectedChatId)?.blockedByPeer ?? false : false),
        [selectedChatId, getSummary]);

    // Toggle only MY side of the block (I can't lift the peer's block).
    const toggleBlock = useCallback(async () => {
        if (!selectedChatId) return;
        try {
            if (selectedBlockedByMe) { await unblockChat({chatId: selectedChatId}).unwrap(); toast.success(t("chat.unblocked")); }
            else { await blockChat({chatId: selectedChatId}).unwrap(); toast.success(t("chat.blocked")); }
        } catch { toast.error(t("chat.blockError")); }
    }, [selectedChatId, selectedBlockedByMe, unblockChat, blockChat, t]);

    const deleteMessage = useCallback(async (messageId: string, attachmentId?: string) => {
        if (!selectedChatId) return;
        // The backend deletes by EITHER id, so send the one we have — no cache read, no refetch.
        // A ULID is the server id (backendId); anything else is still the temporary client id
        // (clientMessageId, which the backend also resolves). Reconciled rows carry the ULID already.
        const server = isUlid(messageId);
        try {
            await deleteMessageMut({
                chatId: selectedChatId,
                backendId: server ? messageId : undefined,
                clientMessageId: server ? undefined : messageId,
            }).unwrap();
            // Deleted a media message → drop its cached blob too (no orphan lingering until logout).
            if (attachmentId) deleteAttachmentBlob(attachmentId).catch(() => { /* best-effort */ });
        } catch (e) {
            const st = (e as {status?: number})?.status;
            toast.error(st === 409 ? t("chat.msgFrozen") : t("chat.msgDeleteError"));
        }
    }, [selectedChatId, deleteMessageMut, t]);

    return {selectedBlocked, selectedBlockedByMe, selectedBlockedByPeer, toggleBlock, deleteMessage};
}
