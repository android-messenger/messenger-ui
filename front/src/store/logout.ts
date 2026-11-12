import type {AppDispatch} from "./store.ts";
import {clearUser} from "@/features/auth/slices/userSlice.ts";
import {chatApi} from "@/features/chat/rest/chatApi.ts";
import {contactsApi} from "@/features/contacts/rest/contactsApi.ts";
import {idsApi} from "@/features/directory/idsApi.ts";
import {clearAllLocalData} from "@/features/chat/db/db.ts";
import {clearAllDrafts} from "@/features/chat/model/drafts.ts";
import {clearSecretChats} from "@/features/chat/model/slices/secretChatsSlice.ts";

/**
 * Full client-state teardown on logout, orchestrated at the composition root (store) — the ONE layer
 * allowed to reach across features. Disconnects the WS, resets the user (which cascades to the outbox /
 * chatUi / presence slices) and every RTK Query cache, and wipes on-disk data (IndexedDB history/outbox/
 * media + localStorage drafts) so the next user on this device inherits nothing. The E2EE keys and the
 * stored secret messages are erased right after this by fullLogout (wipeE2eeData).
 *
 * NOT the Kratos session invalidation or the push-unsubscribe — those are flow-ordered network steps the
 * LogoutPage runs while the session cookie is still valid, before it navigates away.
 */
export const logoutResetClientState = () => (dispatch: AppDispatch) => {
    dispatch({type: "ws/disconnect"});
    dispatch(clearUser());
    dispatch(clearSecretChats());
    dispatch(chatApi.util.resetApiState());
    dispatch(contactsApi.util.resetApiState());
    dispatch(idsApi.util.resetApiState());
    clearAllLocalData().catch(() => { /* best-effort wipe */ });
    clearAllDrafts();
};
