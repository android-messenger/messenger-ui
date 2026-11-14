import {dropForeignCache, type AppDispatch} from "@/store/store";
import {setUser} from "@/features/auth/slices/userSlice.ts";
import {startE2eeUpkeep, ensureE2eeOwner} from "@/features/e2ee";
import {markLogin} from "@/shared/diag/diag.ts";

/** What the session check gives about the signed-in user. */
export interface SessionIdentity {
    id: string;
    traits?: unknown;
}

/**
 * A live session was found: make the device belong to this user, then put the user into the store.
 * The one place where a session becomes "signed in" — RequireAuth calls it, and so do the tests of the
 * message path (src/__path__/bench.ts).
 */
export async function enterSession(dispatch: AppDispatch, identity: SessionIdentity): Promise<void> {
    // Before anything reads a key: E2EE data left on this device by ANOTHER user (or by an
    // interrupted logout) is erased here (spec 001, FR-005, FR-006). Never throws.
    // The chat cache has no owner mark of its own: it goes together with the E2EE data.
    if (await ensureE2eeOwner(identity.id)) await dispatch(dropForeignCache());

    // Kratos `traits.name` may be a string OR an object ({first,last}),
    // depending on the identity schema. Coerce to a non-empty string so the
    // downstream `isNotLogged(name)` gate never calls .trim() on a non-string.
    const traits = (identity.traits ?? {}) as {name?: unknown; email?: string};
    const rawName = traits.name;
    const displayName =
        typeof rawName === "string"
            ? rawName
            : rawName && typeof rawName === "object"
                ? [(rawName as {first?: string}).first, (rawName as {last?: string}).last].filter(Boolean).join(" ").trim()
                : "";

    dispatch(setUser({id: identity.id, name: displayName || traits.email || identity.id}));
    markLogin();   // diagnostics: session start
    // Housekeeping of stored secret-message texts (the Android app only). Never affects login.
    startE2eeUpkeep();
}
