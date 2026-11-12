// The ONE list of everything secret chats keep on this device (spec 001, FR-002). Logout
// (wipeE2eeData), the panic wipe (diagnostics/wipeStorage) and the tests all read it from here, so a
// store added to the code and not to this list fails a test instead of surviving a logout.
//
// No imports: the chat slice and the diagnostics feature read these names too.

/** IndexedDB databases of the E2EE feature. Every `openDB` in features/e2ee takes its name from here. */
export const E2EE_DB = {
    device: "e2ee-device",          // the device wrapping key (browser; the Android app uses the Vault)
    signal: "e2ee-signal",          // Signal identity, prekeys, sessions, peer identities, the owner
    plaintext: "e2ee-plaintext",    // wrapped text of secret messages
    recovery: "e2ee-recovery",      // pending client-to-client recovery
} as const;

export const E2EE_DATABASES: readonly string[] = Object.values(E2EE_DB);

/** localStorage keys of the E2EE feature. */
export const E2EE_LS = {
    secretChats: "wolp.secretChats",     // which chats are in secret mode
    verified: "wolp.e2eeVerified",       // peers marked verified by safety number
} as const;

export const E2EE_LOCAL_KEYS: readonly string[] = Object.values(E2EE_LS);

/** Set before the first deletion of a wipe and removed after the last one (FR-005). Not user data. */
export const E2EE_WIPE_PENDING_KEY = "wolp.e2eeWipePending";
