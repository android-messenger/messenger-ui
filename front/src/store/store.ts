import { configureStore } from "@reduxjs/toolkit";

// Reducers
import userReducer, {clearUser} from "@/features/auth/slices/userSlice";
import callReducer, {webrtcConnected, incomingRemoteEnd} from "@/features/call/model/slices/callSlice";
import wsReducer from "@/infrastructure/slices/websocketSlice.ts";
import chatUiReducer from "@/features/chat/model/slices/chatUiSlice";
import outboxReducer, { hydrateOutbox, mergeOutbox, markPersisted } from "@/features/chat/model/slices/outboxSlice";
import presenceReducer from "@/features/presence/model/presenceSlice";
import stickyChatsReducer, { saveStickyChats, hydrateSticky, STICKY_KEY } from "@/features/chat/model/slices/stickyChatsSlice";
import secretChatsReducer, { saveSecretChats, loadSecretChats, clearSecretChats, hydrateSecretChats, type SecretChats } from "@/features/chat/model/slices/secretChatsSlice";
import { dropPersistedDrafts, hydrateDrafts, DRAFTS_KEY } from "@/features/chat/model/drafts.ts";
import type { ChatSummary } from "@/entities/conversation";

// Middleware
import { createCallMiddleware } from "@/features/call/middleware/callMiddleware";
import { createWebsocketMiddleware } from "@/infrastructure/middleware/wsMiddleware.ts";
import { presenceMiddleware } from "@/features/presence/middleware/presenceMiddleware.ts";
import { chatMiddleware } from "@/features/chat/middleware/chatMiddleware.ts";
import { authErrorListener } from "@/features/auth/middleware/authErrorMiddleware.ts";
import { e2eeRecoveryMiddleware, finishPendingE2eeWipe } from "@/features/e2ee";

// DB functions
import { loadOutboxFromDB, saveOutboxToDB, scrubHistoryCache, dropOpenCache, kvGet, KV, type KvName } from "@/features/chat/db/db";
import { sealing } from "@/features/chat/db/sealed.ts";
import { E2EE_LS } from "@/features/e2ee/wire.ts";
import { sweepRenamedStores } from "@/shared/storage/renamedStores.ts";
import { chatApi } from "@/features/chat/rest/chatApi.ts";
import { contactsApi } from "@/features/contacts/rest/contactsApi.ts";
import { idsApi } from "@/features/directory/idsApi.ts";
import type {WebRTCService} from "@/features/call/service/webRTCService.ts";
import { kratos } from "@/features/auth";
import { selectCallConversationId } from "@/features/chat/model/directDirectory.ts";

// Android app: the send queue, the lists of sticky and secret chats and the drafts are sealed records,
// read after the phone is unlocked (restoreSealed). Until then none of them is written: a change made in
// the first second must not replace what is stored. In a browser they are read at once.
let listsRestored = !sealing();

export function configureAppStore(webRTCService: WebRTCService) {
    listsRestored = !sealing();
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
        if (!listsRestored) return;
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
        if (!listsRestored) return;
        const cur = store.getState().stickyChats.byId;
        if (cur !== lastSticky) { lastSticky = cur; saveStickyChats(cur); }
    });

    // Persist the secret-chat set the same way (survives reloads).
    let lastSecret = store.getState().secretChats.byId;
    store.subscribe(() => {
        if (!listsRestored) return;
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
    void dropOpenCache();        // Android app: the history and attachments an earlier build stored in the clear
    // Android app: this does not hold up the start — it waits for the phone to be unlocked.
    if (sealing()) {
        void restoreSealed(store);
        return;
    }
    const saved = await loadOutboxFromDB();
    if (saved) {
        store.dispatch(hydrateOutbox(saved));
    }
}

/** A sealed record, or — once, after the update from a build that used localStorage — the value left there. */
async function sealedOrLocal<T>(name: KvName, localKey: string): Promise<T | null> {
    let value: T | null = await kvGet<T>(name, {wait: true});
    try {
        const raw = localStorage.getItem(localKey);
        if (raw !== null) {
            if (value === null) value = JSON.parse(raw) as T;
            localStorage.removeItem(localKey);
        }
    } catch { /* unreadable: dropped */ }
    return value;
}

async function restoreSealed(store: ReturnType<typeof configureAppStore>): Promise<void> {
    try {
        const [outbox, secret, sticky, drafts] = await Promise.all([
            loadOutboxFromDB(),
            sealedOrLocal<SecretChats>(KV.secretChats, E2EE_LS.secretChats),
            sealedOrLocal<Record<string, ChatSummary>>(KV.stickyChats, STICKY_KEY),
            sealedOrLocal<Record<string, string>>(KV.drafts, DRAFTS_KEY),
        ]);
        hydrateDrafts(drafts);
        listsRestored = true;   // from here the subscribers write: the dispatches below save what was merged
        if (outbox) store.dispatch(mergeOutbox(outbox));
        store.dispatch(hydrateSecretChats(secret));
        store.dispatch(hydrateSticky(sticky));
        const byId = store.getState().secretChats.byId;
        dropPersistedDrafts(Object.keys(byId).filter((id) => byId[id]));
    } catch {
        // The key did not come (sign-out while the phone was locked, no Vault): work from memory.
        hydrateDrafts(null);
        listsRestored = true;
        store.dispatch(hydrateSticky(null));   // any action: the subscribers save what was queued meanwhile
    }
}
