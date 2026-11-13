import { configureStore } from "@reduxjs/toolkit";

// Reducers
import userReducer, {clearUser} from "@/features/auth/slices/userSlice";
import callReducer, {webrtcConnected, incomingRemoteEnd} from "@/features/call/model/slices/callSlice";
import wsReducer from "@/infrastructure/slices/websocketSlice.ts";
import chatUiReducer from "@/features/chat/model/slices/chatUiSlice";
import outboxReducer, { hydrateOutbox, mergeOutbox, markPersisted } from "@/features/chat/model/slices/outboxSlice";
import presenceReducer from "@/features/presence/model/presenceSlice";
import stickyChatsReducer, { saveStickyChats, hydrateSticky, clearSticky, STICKY_KEY } from "@/features/chat/model/slices/stickyChatsSlice";
import secretChatsReducer, { saveSecretChats, loadSecretChats, clearSecretChats, hydrateSecretChats, type SecretChats } from "@/features/chat/model/slices/secretChatsSlice";
import { dropPersistedDrafts, hydrateDrafts, clearAllDrafts, DRAFTS_KEY } from "@/features/chat/model/drafts.ts";
import type { ChatSummary } from "@/entities/conversation";

// Middleware
import { createCallMiddleware } from "@/features/call/middleware/callMiddleware";
import { createWebsocketMiddleware } from "@/infrastructure/middleware/wsMiddleware.ts";
import { presenceMiddleware } from "@/features/presence/middleware/presenceMiddleware.ts";
import { chatMiddleware } from "@/features/chat/middleware/chatMiddleware.ts";
import { authErrorListener } from "@/features/auth/middleware/authErrorMiddleware.ts";
import { e2eeRecoveryMiddleware, finishPendingE2eeWipe } from "@/features/e2ee";

// DB functions
import { loadOutboxFromDB, readOutbox, saveOutboxToDB, scrubHistoryCache, dropOpenCache, clearAllLocalData, kvRead, KV } from "@/features/chat/db/db";
import { sealing, type Read } from "@/features/chat/db/sealed.ts";
import { listsReady, setListsReady } from "@/features/chat/model/sealedLists.ts";
import { E2EE_LS } from "@/features/e2ee/wire.ts";
import { sweepRenamedStores } from "@/shared/storage/renamedStores.ts";
import { erasePending, wipeAllStorage } from "@/features/diagnostics/wipeStorage.ts";
import { chatApi } from "@/features/chat/rest/chatApi.ts";
import { contactsApi } from "@/features/contacts/rest/contactsApi.ts";
import { idsApi } from "@/features/directory/idsApi.ts";
import type {WebRTCService} from "@/features/call/service/webRTCService.ts";
import { kratos } from "@/features/auth";
import { selectCallConversationId } from "@/features/chat/model/directDirectory.ts";

// Android app: the send queue, the lists of sticky and secret chats and the drafts are sealed records,
// read after the phone is unlocked (restoreSealed). Until then none of them is written and nothing is
// sent (model/sealedLists.ts). In a browser they are read at once.
let restoreRun = 0;   // a new store, or a new restore, ends the retries of the one before

export function configureAppStore(webRTCService: WebRTCService) {
    restoreRun++;
    setListsReady(!sealing());
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
        if (!listsReady()) return;
        const s = store.getState().outbox;
        if (s.outboxVersion === s.persistedVersion || saveTimer) return;
        saveTimer = setTimeout(() => {
            saveTimer = null;
            const cur = store.getState().outbox;
            if (cur.outboxVersion === cur.persistedVersion) return;
            const savedVersion = cur.outboxVersion;
            // Mark the version we ACTUALLY saved — not the live one at completion time (a message
            // enqueued during the async put would otherwise be marked persisted but never written).
            // A failed write (no key, storage error) leaves the version unmarked: the next change tries again.
            saveOutboxToDB(cur).then(() => store.dispatch(markPersisted(savedVersion))).catch(() => {});
        }, 400);
    });

    // Persist the sticky-chats set to localStorage whenever it changes (Immer gives a fresh byId
    // reference only on an actual change, so this writes just on remember/forget/clear).
    let lastSticky = store.getState().stickyChats.byId;
    store.subscribe(() => {
        if (!listsReady()) return;
        const cur = store.getState().stickyChats.byId;
        if (cur !== lastSticky) { lastSticky = cur; saveStickyChats(cur); }
    });

    // Persist the secret-chat set the same way (survives reloads).
    let lastSecret = store.getState().secretChats.byId;
    store.subscribe(() => {
        if (!listsReady()) return;
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
    // "Erase everything" that was cut short (app killed while the network steps ran) is finished first of all.
    if (erasePending()) await wipeAllStorage();
    if (await finishPendingE2eeWipe()) store.dispatch(clearSecretChats());
    void scrubHistoryCache();
    void sweepRenamedStores();   // what a build before the rename of the stores left on the device
    dropPersistedDrafts(Object.keys(loadSecretChats()));
    void dropOpenCache();        // Android app: the history an earlier build stored in the clear
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

/** How long to wait before the sealed lists are read again after a read that did not succeed. */
export const RESTORE_RETRY_MS = 2_000;

/** Resolves after RESTORE_RETRY_MS, or sooner when the app comes back to the screen. */
function retryPause(): Promise<void> {
    return new Promise<void>((resolve) => {
        const done = () => {
            clearTimeout(timer);
            document.removeEventListener("visibilitychange", onVisible);
            resolve();
        };
        const onVisible = () => { if (document.visibilityState === "visible") done(); };
        const timer = setTimeout(done, RESTORE_RETRY_MS);
        document.addEventListener("visibilitychange", onVisible);
    });
}

/** The value read, or — once, after the update from a build that used localStorage — the value left there. */
function valueOrLocal<T>(read: Read<T>, localKey: string): T | null {
    let value: T | null = read.state === "ok" ? read.value : null;
    try {
        const raw = localStorage.getItem(localKey);
        if (raw !== null) {
            if (value === null) value = JSON.parse(raw) as T;
            localStorage.removeItem(localKey);
        }
    } catch { /* unreadable: dropped */ }
    return value;
}

/**
 * Reads the four sealed records into the store, then lets the app send and write them (setListsReady).
 * A locked phone is waited out inside the read. A read that did not succeed for another reason (the app
 * did not answer, the Vault is closed by the app's check, a storage error) is repeated — on return to the
 * screen and every RESTORE_RETRY_MS — and until then nothing is sent and nothing stored is replaced.
 * A record whose key is lost for good counts as empty (owner's decision 2026-11-13: every chat is then
 * not secret; the user turns the mode on again).
 */
async function restoreSealed(store: Pick<ReturnType<typeof configureAppStore>, "dispatch" | "getState">): Promise<void> {
    const run = ++restoreRun;
    for (;;) {
        const [outbox, secret, sticky, drafts] = await Promise.all([
            readOutbox(),
            kvRead<SecretChats>(KV.secretChats, {wait: true}),
            kvRead<Record<string, ChatSummary>>(KV.stickyChats, {wait: true}),
            kvRead<Record<string, string>>(KV.drafts, {wait: true}),
        ]);
        if (run !== restoreRun) return;
        if ([outbox, secret, sticky, drafts].every((r) => r.state !== "unread")) {
            // What an earlier build kept in localStorage is taken only now: a retry must find it again.
            const savedDrafts = valueOrLocal(drafts, DRAFTS_KEY);
            hydrateDrafts(savedDrafts, {store: savedDrafts !== null && drafts.state !== "ok"});
            setListsReady(true);   // from here the subscribers write: the dispatches below save what was merged
            if (outbox.state === "ok") store.dispatch(mergeOutbox(outbox.value));
            store.dispatch(hydrateSecretChats(valueOrLocal(secret, E2EE_LS.secretChats)));
            store.dispatch(hydrateSticky(valueOrLocal(sticky, STICKY_KEY)));
            const byId = store.getState().secretChats.byId;
            dropPersistedDrafts(Object.keys(byId).filter((id) => byId[id]));
            return;
        }
        await retryPause();
        if (run !== restoreRun) return;
    }
}

/**
 * The cache on this device belongs to another account: its session ended without a sign-out (a 401), so
 * nothing was erased then. Called when the owner check at sign-in found it (RequireAuth). Erases the chat
 * cache, the queue, the lists and the drafts — on disk and in memory — and reads the (now empty) sealed
 * lists again, so a read that was still waiting for the Vault cannot bring the other account's lists back.
 */
export const dropForeignCache = () => async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    restoreRun++;                       // a restore in flight gives up
    if (sealing()) setListsReady(false);
    dispatch(clearSecretChats());
    dispatch(clearSticky());
    clearAllDrafts();
    await clearAllLocalData().catch(() => { /* best-effort */ });
    if (sealing()) void restoreSealed({dispatch, getState});
};
