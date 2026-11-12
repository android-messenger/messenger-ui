import { configureStore } from "@reduxjs/toolkit";

// Reducers
import userReducer, {clearUser} from "@/features/auth/slices/userSlice";
import callReducer, {webrtcConnected, incomingRemoteEnd} from "@/features/call/model/slices/callSlice";
import wsReducer from "@/infrastructure/slices/websocketSlice.ts";
import chatUiReducer from "@/features/chat/model/slices/chatUiSlice";
import outboxReducer, { hydrateOutbox, markPersisted } from "@/features/chat/model/slices/outboxSlice";
import presenceReducer from "@/features/presence/model/presenceSlice";
import stickyChatsReducer, { saveStickyChats } from "@/features/chat/model/slices/stickyChatsSlice";
import secretChatsReducer, { saveSecretChats, loadSecretChats, clearSecretChats } from "@/features/chat/model/slices/secretChatsSlice";
import { dropPersistedDrafts } from "@/features/chat/model/drafts.ts";

// Middleware
import { createCallMiddleware } from "@/features/call/middleware/callMiddleware";
import { createWebsocketMiddleware } from "@/infrastructure/middleware/wsMiddleware.ts";
import { presenceMiddleware } from "@/features/presence/middleware/presenceMiddleware.ts";
import { chatMiddleware } from "@/features/chat/middleware/chatMiddleware.ts";
import { authErrorListener } from "@/features/auth/middleware/authErrorMiddleware.ts";
import { e2eeRecoveryMiddleware, finishPendingE2eeWipe } from "@/features/e2ee";

// DB functions
import { loadOutboxFromDB, saveOutboxToDB, scrubHistoryCache } from "@/features/chat/db/db";
import { sweepRenamedStores } from "@/shared/storage/renamedStores.ts";
import { chatApi } from "@/features/chat/rest/chatApi.ts";
import { contactsApi } from "@/features/contacts/rest/contactsApi.ts";
import { idsApi } from "@/features/directory/idsApi.ts";
import type {WebRTCService} from "@/features/call/service/webRTCService.ts";
import { kratos } from "@/features/auth";
import { selectCallConversationId } from "@/features/chat/model/directDirectory.ts";

export function configureAppStore(webRTCService: WebRTCService) {
    const store = configureStore({
        reducer: {
            call: callReducer,
            ws: wsReducer,
            outbox: outboxReducer,
            user: userReducer,
            chatUi: chatUiReducer,
            presence: presenceReducer,
            stickyChats: stickyChatsReducer,
            secretChats: secretChatsReducer,
            [chatApi.reducerPath]: chatApi.reducer,
            [contactsApi.reducerPath]: contactsApi.reducer,
            [idsApi.reducerPath]: idsApi.reducer,
        },
        middleware: (getDefaultMiddleware) =>
            getDefaultMiddleware().prepend(authErrorListener.middleware).concat(
                chatApi.middleware,
                contactsApi.middleware,
                idsApi.middleware,
                // Inject the feature-owned bits so the WS transport stays feature-agnostic (see wsMiddleware).
                createWebsocketMiddleware({
                    probeSession: () => kratos.toSession(),
                    clearUser,
                    callConversationId: (state, to) => {
                        // Prefer the explicit id the current call carries (a push deep-link sets it, so
                        // the frame works on a cold start before getChats loads); otherwise resolve from
                        // the UNION directory (getChats ∪ sticky), which also covers an open empty chat.
                        // Loose casts (not RootState) — RootState is derived FROM this store, so naming it
                        // here would be a circular type reference.
                        const explicit = (state as {call?: {conversationId?: string | null}}).call?.conversationId;
                        return explicit ?? selectCallConversationId(state as never, to);
                    },
                }),
                presenceMiddleware,
                chatMiddleware,
                e2eeRecoveryMiddleware,
                createCallMiddleware(webRTCService)
            ),
    });

    // Persist the outbox to IndexedDB, debounced: the subscriber runs on every dispatched action,
    // so coalesce a burst of outbox changes (enqueue → sending → sent) into one write.
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    store.subscribe(() => {
        const s = store.getState().outbox;
        if (s.outboxVersion === s.persistedVersion || saveTimer) return;
        saveTimer = setTimeout(() => {
            saveTimer = null;
            const cur = store.getState().outbox;
            if (cur.outboxVersion === cur.persistedVersion) return;
            const savedVersion = cur.outboxVersion;
            // Mark the version we ACTUALLY saved — not the live one at completion time (a message
            // enqueued during the async put would otherwise be marked persisted but never written).
            saveOutboxToDB(cur).then(() => store.dispatch(markPersisted(savedVersion)));
        }, 400);
    });

    // Persist the sticky-chats set to localStorage whenever it changes (Immer gives a fresh byId
    // reference only on an actual change, so this writes just on remember/forget/clear).
    let lastSticky = store.getState().stickyChats.byId;
    store.subscribe(() => {
        const cur = store.getState().stickyChats.byId;
        if (cur !== lastSticky) { lastSticky = cur; saveStickyChats(cur); }
    });

    // Persist the secret-chat set the same way (survives reloads).
    let lastSecret = store.getState().secretChats.byId;
    store.subscribe(() => {
        const cur = store.getState().secretChats.byId;
        if (cur !== lastSecret) {
            // A chat that just became secret must not keep a draft in localStorage.
            dropPersistedDrafts(Object.keys(cur).filter((id) => cur[id] && !lastSecret[id]));
            lastSecret = cur;
            saveSecretChats(cur);
        }
    });

    webRTCService.setSendCallback((data) => {
        store.dispatch({type: "ws/send", payload: data});
    });

    // Reflect the peer-connection lifecycle into Redux: connected → in_call; failed/closed → idle
    // (the service has already released camera/mic + pc by the time onEnded fires).
    webRTCService.setEventCallbacks(
        () => store.dispatch(webrtcConnected()),
        () => store.dispatch(incomingRemoteEnd()),
    );

    return store;
}

export type RootState = ReturnType<ReturnType<typeof configureAppStore>["getState"]>;
export type AppDispatch = ReturnType<typeof configureAppStore>["dispatch"];

export async function hydrateStore(store: ReturnType<typeof configureAppStore>) {
    // Remove what earlier client versions left on disk in the clear for secret chats: decrypted rows
    // in the history cache and drafts in localStorage. Neither blocks startup.
    // A logout wipe that was cut short (tab closed, app killed, a database held by another tab) is
    // finished first — before anything reads a key (spec 001, FR-005). The secret-chat set was loaded
    // from localStorage when the store was created, so drop the in-memory copy as well.
    if (await finishPendingE2eeWipe()) store.dispatch(clearSecretChats());
    void scrubHistoryCache();
    void sweepRenamedStores();   // what a build before the rename of the stores left on the device
    dropPersistedDrafts(Object.keys(loadSecretChats()));
    const saved = await loadOutboxFromDB();
    if (saved) {
        store.dispatch(hydrateOutbox(saved));
    }
}
