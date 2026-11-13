import {useEffect, useRef} from "react";
import {useDispatch, useSelector, useStore} from "react-redux";
import {useTranslation} from "react-i18next";
import type {AppDispatch, RootState} from "@/store/store";
import {chatMessagesService} from "@/features/chat/model/services/chatMessages.service.ts";
import {selectCallConversationId} from "@/features/chat/model/directDirectory.ts";
import {callNoteKey, missedCallMeta} from "@/features/chat/model/callNote.ts";
import {listsReady} from "@/features/chat/model/sealedLists.ts";

type Summary = {counterpartId: string; orderId?: string} | null | undefined;

/**
 * Leaves "unanswered call" in the chat when MY outgoing call ends before it was answered: nobody picked
 * up, I gave up, the other side was busy or declined (model/callNote.ts). Sent by the caller only, once
 * per call. The line follows the chat's mode: in a secret chat it is encrypted like any message.
 */
export function useMissedCallNote(params: {myId: string; getSummary: (chatId: string) => Summary}) {
    const {myId, getSummary} = params;
    const dispatch = useDispatch<AppDispatch>();
    const store = useStore<RootState>();
    const {t} = useTranslation();
    const status = useSelector((s: RootState) => s.call.status);
    const peerId = useSelector((s: RootState) => s.call.peerId);
    const audioOnly = useSelector((s: RootState) => s.call.audioOnly);
    // The outgoing call that is ringing at the other side right now; null once it is answered or over.
    const dialing = useRef<{peerId: string; audioOnly: boolean} | null>(null);

    useEffect(() => {
        if (status === "calling") {
            if (peerId) dialing.current = {peerId, audioOnly};
            return;
        }
        const call = dialing.current;
        dialing.current = null;
        if (status !== "idle" || !call) return;   // answered (connecting / in_call), or nothing was dialled
        const state = store.getState();
        const chatId = state.call.conversationId ?? selectCallConversationId(state, call.peerId);
        const summary = chatId ? getSummary(chatId) : null;
        if (!chatId || !summary || !listsReady()) return;   // no chat to write to; no note is not an error
        const meta = missedCallMeta(call.audioOnly);
        const secret = !!state.secretChats.byId[chatId];
        void chatMessagesService.enqueueChatMessage(
            dispatch, "📞 " + t(callNoteKey(meta)!), myId, chatId, summary.counterpartId, summary.orderId, secret, meta,
        );
    }, [status, peerId, audioOnly, store, getSummary, dispatch, myId, t]);
}
