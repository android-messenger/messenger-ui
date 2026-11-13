import {openDB, type IDBPDatabase} from "idb";
import {E2EE_DB} from "./stores.ts";

// Whose secret-chat data is on this device (spec 001, FR-006). A plain value: reading it needs no Vault.
//
// The database is the one the interface used to keep its own keys in, before the keys moved to the Android
// app's library. The object stores of that time are still declared, so a database written by an older
// version opens as it is; dropLegacyKeys() empties them.

const V = 2;
const META = "meta";
const LEGACY = ["prekeys", "signedprekeys", "sessions", "peers", "roster"];
const OWNER = "owner";

function db(): Promise<IDBPDatabase> {
    const p: Promise<IDBPDatabase> = openDB(E2EE_DB.signal, V, {
        upgrade(d) {
            for (const s of [META, ...LEGACY]) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
        },
        // A wipe (logout) asks to delete this database: let go at once, or the deletion stays blocked.
        blocking() { void p.then((d) => d.close(), () => {}); },
    });
    return p;
}

export async function getOwner(): Promise<string | undefined> {
    return (await (await db()).get(META, OWNER)) as string | undefined;
}

export async function setOwner(userId: string): Promise<void> {
    await (await db()).put(META, userId, OWNER);
}

/** Erases every key, session and remembered peer an older version of the interface left here; the owner stays. */
export async function dropLegacyKeys(): Promise<void> {
    const d = await db();
    const owner = await d.get(META, OWNER);
    const tx = d.transaction([META, ...LEGACY], "readwrite");
    for (const s of [META, ...LEGACY]) await tx.objectStore(s).clear();
    if (owner !== undefined) await tx.objectStore(META).put(owner, OWNER);
    await tx.done;
}
