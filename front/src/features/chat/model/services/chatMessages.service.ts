import {type AppDispatch, type RootState} from "@/store/store";
import {chatApi} from "@/features/chat/rest/chatApi";
import {logger} from "@/shared/logger/logger.ts";
import {enqueueMessage} from "@/features/chat/model/slices/outboxSlice.ts";
import {toOutboxMessage} from "@/features/chat/model/mapper.ts";
import {upsertMessage} from "@/features/chat/model/historyCache.ts";
import {flushOutbox} from "@/features/chat/thunk/sendOutboxThunk.ts";
import {preserveSelectedConversation} from "@/features/chat/model/preserveSelectedConversation.ts";
import {secretCrypto, savePlaintext, deletePlaintextForChat} from "@/features/e2ee";
import {sendFailureKey} from "@/features/e2ee/wire.ts";
import {deleteChatCache} from "@/features/chat/db/db.ts";
import toast from "react-hot-toast";
import i18n from "@/shared/i18n";

// ANTI-JITTER ONLY — not idempotency. Suppresses a single gesture firing twice within a few hundred
// ms (mobile IME double-Enter, double-tap). It must be short enough to NEVER eat a deliberate human
// re-send after a perceived non-delivery (that happens seconds later) — a longer window silently
// dropped real messages. True dedup of a resend-after-lost-ACK is the SERVER's job (dedup by
// client_message_id, which the client sends and reuses on resend); the client cannot do it without
// losing legitimate repeats.
const DUP_SEND_WINDOW_MS = 400;
let lastEnqueue = {key: "", at: 0};


export const chatMessagesService = {
    // Refetch the chat list, but keep the currently-selected conversation if the fresh list omits it
    // (a just-created, still-message-less chat the backend hides from GET /chats — injected+selected
    // by AddUser). EVERY getChats refetch path must go through this, or the selected chat vanishes and
    // useChat's dangling-close then drops the open window. Used by the resume/reconnect catch-up AND
    // the middleware's unknown-conversation refresh.
    refetchChatsPreservingSelected(dispatch: AppDispatch, getState: () => RootState) {
        const state = getState();
        const myId = state.user?.id;
        if (!myId) return;
        const selectedChatId = state.chatUi?.selectedChatId ?? null;
        const before = chatApi.endpoints.getChats.select({myId})(state)?.data;
        return dispatch(chatApi.endpoints.getChats.initiate({myId}, {forceRefetch: true}))
            .unwrap()
            .then(() => {
                dispatch(chatApi.util.updateQueryData("getChats", {myId}, (draft) =>
                    preserveSelectedConversation(draft ?? [], before, selectedChatId)));
            })
            .catch(() => { /* best-effort */ });
    },
    async clearChatHistory(dispatch: AppDispatch,
                           deleteHistory: ReturnType<typeof chatApi.useDeleteChatHistoryMutation>[0],
                           myId: string, chatId: string | null) {
        if (!chatId) return;
        logger.debug("deleted chat data", chatId);
        try {
            await deleteHistory({myId, chatId}).unwrap();
            void deletePlaintextForChat(chatId);   // wipe locally-stored decrypted secret messages
            void deleteChatCache(chatId);           // wipe cached attachment files + history rows
            dispatch(
                chatApi.util.updateQueryData(
                    "getChatHistory",
                    {myId, chatId},
                    () => []
                )
            );
        } catch (err) {
            logger.error("Failed to clear chat", err as Error);
        }
    },

    reloadChatHistory(dispatch: AppDispatch, myId: string, chatId: string | null) {
        if (!chatId) return;
        logger.debug("reloading chat data", chatId);
        return dispatch(
            chatApi.endpoints.getChatHistory.initiate({myId, chatId}, {forceRefetch: true})
        );
    },


    async enqueueChatMessage(
        dispatch: AppDispatch,
        text: string,
        myId: string,
        conversationId: string | null,
        recipientId: string,
        orderId?: string,
        secret = false
    ) {
        // No recipientId requirement: a GROUP send carries an empty recipientId (the server fans out to
        // the roster by conversationId). A 1:1 still passes its counterpart, so nothing changes there.
        if (!conversationId || !text.trim()) return;

        // Idempotency guard against a double-fire of a single user action: Enter AND the Send button
        // both call sendMessage with the same text, and event jitter / double-taps repeat it — each
        // enqueue mints a fresh client id, and the backend has no server-side dedup, so it becomes two
        // messages. Suppress an identical (conversation, text) enqueue within a short window. A
        // deliberate repeat after the window still goes through.
        const key = `${conversationId}\0${text.trim()}`;
        const now = Date.now();
        if (key === lastEnqueue.key && now - lastEnqueue.at < DUP_SEND_WINDOW_MS) {
            logger.debug("duplicate send suppressed (idempotency window)");
            return;
        }
        lastEnqueue = {key, at: now};

        logger.debug("sending chat message via a queue");

        // SECRET chat: encrypt the plaintext into the wire body (marker + envelope). FAIL CLOSED — if
        // encryption fails (no keys, directory down, crypto blocked) we must NOT send plaintext; abort and
        // tell the user. Only 1:1 is secret in v1 (needs a recipient); groups never reach here as secret.
        let wireText = text;
        if (secret && !recipientId) {
            // A secret chat with no known recipient cannot be encrypted. Never send it in the clear.
            logger.error("e2ee: secret chat without a recipient — NOT sending (fail-closed)");
            toast.error(i18n.t("chat.encryptFailed"));
            return;
        }
        if (secret && recipientId) {
            try {
                wireText = await secretCrypto.encrypt(recipientId, text);
            } catch (e) {
                logger.error("e2ee: encrypt failed — NOT sending (fail-closed)", e as Error);
                // The user is told why (no device, not in the app, a key that failed the check, a verified
                // contact whose key changed, no connection to the key directory); anything else is generic.
                toast.error(i18n.t(sendFailureKey(e)));
                return;
            }
        }

        // The wire carries `wireText` (ciphertext for a secret chat); the optimistic echo below keeps the
        // PLAINTEXT so the sender sees what they typed.
        const outboxMsg = toOutboxMessage({conversationId, recipientId, text: wireText, orderId});
        // At-rest: the wire carries ciphertext encrypted to the PEER (not to us), so we can't read our OWN
        // sent secret message back from reloaded history. Stash our plaintext under the client id (the row's
        // correlationId after a reload) so history rendering can restore it.
        // Tag our OWN outgoing secret plaintext with the recipient, so client-to-client recovery can
        // re-send it only to them (never to whoever presents the server-visible clientId).
        if (secret && recipientId) {
            void savePlaintext(outboxMsg.id, conversationId, text, recipientId).then((saved) => {
                if (saved) return;
                // Our own text is readable after a reload only from this store: tell the user it is not there.
                dispatch(chatApi.util.updateQueryData("getChatHistory", {myId, chatId: conversationId}, (draft) => {
                    const row = draft?.find((m) => m.id === outboxMsg.id || m.clientId === outboxMsg.id);
                    if (row) row.unsaved = true;
                }));
            });
        }
        dispatch(enqueueMessage(outboxMsg));

        // Optimistic echo: the backend does NOT send CHAT_OUT back to the sender (only a
        // CHAT_ACK), so show our own message immediately. The client messageId is used as
        // the id; on the next history read-through RTK Query replaces the list with the
        // server's authoritative rows, so this transient copy can't duplicate.
        const optimistic = {
            id: outboxMsg.id,
            clientId: outboxMsg.id,   // dedup key (matches correlationId on echoes)
            chatId: conversationId,
            from: myId,
            to: recipientId,
            text,
            createdAt: new Date(),
            status: "sent" as const,
            secret: secret && !!recipientId,   // 🔒 marker on my own secret messages
        };
        dispatch(
            chatApi.util.updateQueryData(
                "getChatHistory",
                {myId, chatId: conversationId},
                (draft) => {
                    // Seed the array when history hasn't loaded yet (e.g. the chat was opened while
                    // OFFLINE → getChatHistory errored → data is undefined). Without this the echo
                    // was silently dropped and the 🕐 message only appeared after reconnect.
                    if (!draft) return [optimistic];
                    upsertMessage(draft, optimistic); // canonical id||clientId dedup (model/historyCache)
                }
            )
        );

        dispatch(flushOutbox());
    },
};
