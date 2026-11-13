import "fake-indexeddb/auto";
import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";
import {openDB} from "idb";

// Spec 001, story 1 (finding 13): logging out must leave no E2EE keys, no secret history and no marks
// on the device. Real IndexedDB (fake-indexeddb) and real localStorage; the network and the Android app
// (its Vault and its sign-out calls) are stubbed. Secret data exists only in the app, so the tests run as
// the app; what older browser versions left behind is seeded by hand.

vi.mock("@/features/auth/model/services/kratosFlows.ts", () => ({
    logout: vi.fn(async () => "https://kratos.internal/self-service/logout?token=t"),
}));
vi.mock("@/features/notifications", () => ({removePushSubscription: vi.fn(async () => {})}));

import {configureAppStore, hydrateStore} from "../store";
import {fullLogout} from "@/features/auth/model/services/fullLogout";
import {setUser, clearUser} from "@/features/auth/slices/userSlice";
import {ensureE2eeOwner, wipeE2eeData, finishPendingE2eeWipe} from "@/features/e2ee";
import {E2EE_DATABASES, E2EE_LOCAL_KEYS, E2EE_WIPE_PENDING_KEY} from "@/features/e2ee/lib/stores";
import {markSecret} from "@/features/chat/model/slices/secretChatsSlice";
import {getOwner} from "@/features/e2ee/lib/ownerStore";
import {installFakeApp} from "@/features/e2ee/lib/__tests__/fakeApp";
import {savePlaintext, loadPlaintext} from "@/features/e2ee/lib/atRest";
import {addPending} from "@/features/e2ee/recovery/pendingStore";
import type {WebRTCService} from "@/features/call/service/webRTCService";

// Written out, not imported: the test must fail if a name silently leaves the list.
const E2EE_DBS = ["e2ee-device", "e2ee-signal", "e2ee-plaintext", "e2ee-recovery"];
const E2EE_KEYS = ["wolp.secretChats", "wolp.e2eeVerified"];
const webrtc = {setSendCallback: () => {}, setEventCallbacks: () => {}} as unknown as WebRTCService;

async function dbNames(): Promise<string[]> {
    return (await indexedDB.databases()).map((d) => d.name ?? "");
}

/** A value of the database older versions kept their keys in; undefined when it is not there. */
async function signalMeta(key: string): Promise<unknown> {
    const d = await openDB("e2ee-signal");
    try { return d.objectStoreNames.contains("meta") ? await d.get("meta", key) : undefined; } finally { d.close(); }
}

/** Everything a user who used secret chats leaves on the device, leftovers of older versions included. */
async function seedUserData(store: ReturnType<typeof configureAppStore>) {
    (await openDB("e2ee-device", 1, {upgrade(d) { d.createObjectStore("wrap"); }})).close();
    const signal = await openDB("e2ee-signal", 2, {
        upgrade(d) { for (const s of ["meta", "prekeys", "signedprekeys", "sessions", "peers", "roster"]) d.createObjectStore(s); },
    });
    await signal.put("meta", "device-A", "deviceId");
    await signal.put("meta", {pub: new ArrayBuffer(4), priv: {kind: "native", blob: "x"}}, "identity");
    await signal.put("roster", {deviceIds: ["peer-dev"], fetchedAt: 1}, "peer-1");
    signal.close();
    await savePlaintext("m1", "c-secret", "meet at the old bridge at nine");
    expect(await loadPlaintext("m1")).toBe("meet at the old bridge at nine");
    await addPending([{clientId: "k1", serverId: "s1", chatId: "c-secret", peerId: "peer-1"}]);
    localStorage.setItem("wolp.e2eeVerified", JSON.stringify({"peer-1": "12345 67890"}));
    store.dispatch(markSecret("c-secret"));
}

const fetchMock = vi.fn();
const noContent = () => Promise.resolve({ok: true, status: 204, text: async () => "", headers: new Headers()});
let app: ReturnType<typeof installFakeApp>;
const keyDirectoryCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/key-directory"));

async function expectNothingLeft() {
    const left = await dbNames();
    for (const name of E2EE_DBS) expect(left).not.toContain(name);
    for (const key of E2EE_KEYS) expect(localStorage.getItem(key)).toBeNull();
}

async function loggedInStoreWithData(userId = "user-A") {
    const store = configureAppStore(webrtc);
    store.dispatch(setUser({id: userId, name: userId}));
    await ensureE2eeOwner(userId);
    await seedUserData(store);
    return store;
}

describe("logout wipes E2EE keys and secret data", () => {
    beforeEach(async () => {
        app = installFakeApp();
        await wipeE2eeData();
        localStorage.clear();
        fetchMock.mockReset();
        fetchMock.mockImplementation(noContent);
        vi.stubGlobal("fetch", fetchMock);
    });
    afterEach(() => { app.uninstall(); vi.unstubAllGlobals(); });

    it("the list of stores is the four databases and the two localStorage keys", () => {
        expect([...E2EE_DATABASES].sort()).toEqual([...E2EE_DBS].sort());
        expect([...E2EE_LOCAL_KEYS].sort()).toEqual([...E2EE_KEYS].sort());
    });

    it("after logout no E2EE database and no E2EE localStorage key is left (scenario 1.1)", async () => {
        const store = await loggedInStoreWithData();
        expect(await dbNames()).toEqual(expect.arrayContaining(E2EE_DBS));
        expect(store.getState().secretChats.byId).toEqual({"c-secret": true});   // in the app the list is not in localStorage
        expect(localStorage.getItem("wolp.secretChats")).toBeNull();
        expect(localStorage.getItem("wolp.e2eeVerified")).toContain("peer-1");

        await fullLogout(store.dispatch);

        await expectNothingLeft();
        expect(store.getState().secretChats.byId).toEqual({});
        expect(localStorage.getItem(E2EE_WIPE_PENDING_KEY)).toBeNull();
    });

    it("the next user on the device inherits nothing (scenario 1.2)", async () => {
        const a = await loggedInStoreWithData("user-A");
        await fullLogout(a.dispatch);

        // user B: a new page (new store), then the login check
        const b = configureAppStore(webrtc);
        expect(await ensureE2eeOwner("user-B")).toBe(false);   // nothing of A was left to erase
        b.dispatch(setUser({id: "user-B", name: "B"}));

        expect(await signalMeta("identity")).toBeUndefined();
        expect(await signalMeta("deviceId")).toBeUndefined();
        expect(await getOwner()).toBe("user-B");
        expect(await loadPlaintext("m1")).toBeNull();
        expect(b.getState().secretChats.byId).toEqual({});
    });

    it("the app erases its keys and its directory record while the session is still valid (scenario 1.3)", async () => {
        const store = await loggedInStoreWithData();

        await fullLogout(store.dispatch);

        expect(app.plugin.e2eeWipe).toHaveBeenCalledTimes(1);
        const kratos = fetchMock.mock.calls.findIndex(([url]) => String(url).includes("/self-service/logout"));
        expect(kratos).toBeGreaterThanOrEqual(0);
        // the session is invalidated AFTER the app was asked
        expect(app.plugin.e2eeWipe.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[kratos]);
        expect(keyDirectoryCalls()).toEqual([]);                 // the interface itself never talks to the key directory
    });

    it("logout and the wipe still finish when the app fails to erase its keys (scenario 1.4)", async () => {
        const store = await loggedInStoreWithData();
        app.plugin.e2eeWipe.mockRejectedValueOnce(Object.assign(new Error("not implemented"), {code: "UNIMPLEMENTED"}));

        await fullLogout(store.dispatch);

        await expectNothingLeft();
        expect(store.getState().user.id).toBe("Anonimo");
    });

    it("a browser logs out without the app and without the key directory; leftovers of older versions go", async () => {
        const store = await loggedInStoreWithData();             // what an older browser version left behind
        app.uninstall();

        await fullLogout(store.dispatch);

        expect(keyDirectoryCalls()).toEqual([]);
        expect(app.plugin.e2eeWipe).not.toHaveBeenCalled();
        await expectNothingLeft();
    });

    it("an interrupted wipe is finished at the next start, before the store is used (scenario 1.5)", async () => {
        await loggedInStoreWithData();
        // the wipe started (mark set) and the page died before any database was deleted
        localStorage.setItem(E2EE_WIPE_PENDING_KEY, "1");

        const next = configureAppStore(webrtc);                  // the page starts again
        // the slice reads localStorage when the page loads — the new page starts with A's secret-chat set
        next.dispatch(markSecret("c-secret"));
        await hydrateStore(next);

        await expectNothingLeft();
        expect(localStorage.getItem(E2EE_WIPE_PENDING_KEY)).toBeNull();
        expect(next.getState().secretChats.byId).toEqual({});
    });

    it("a database held open elsewhere does not hang the wipe; it is finished later (scenario 1.5, edge)", async () => {
        await loggedInStoreWithData();
        // another tab: a connection that ignores the request to close
        const other = await new Promise<IDBDatabase>((resolve, reject) => {
            const r = indexedDB.open("e2ee-plaintext");
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });

        await wipeE2eeData();                                    // resolves although one deletion is blocked

        expect(localStorage.getItem(E2EE_WIPE_PENDING_KEY)).toBe("1");
        for (const key of E2EE_KEYS) expect(localStorage.getItem(key)).toBeNull();
        other.close();                                           // the other tab goes away
        expect(await finishPendingE2eeWipe()).toBe(true);
        await expectNothingLeft();
        expect(localStorage.getItem(E2EE_WIPE_PENDING_KEY)).toBeNull();
        expect(await finishPendingE2eeWipe()).toBe(false);       // nothing left to finish
    });

    it("data of another user is erased at login, before first use (scenario 1.6)", async () => {
        await loggedInStoreWithData("user-A");                   // A never logged out (old client, crash)

        expect(await ensureE2eeOwner("user-B")).toBe(true);

        const left = await dbNames();
        for (const name of ["e2ee-device", "e2ee-plaintext", "e2ee-recovery"]) expect(left).not.toContain(name);
        for (const key of E2EE_KEYS) expect(localStorage.getItem(key)).toBeNull();
        expect(await signalMeta("identity")).toBeUndefined();
        expect(await getOwner()).toBe("user-B");
        expect(await loadPlaintext("m1")).toBeNull();
    });

    it("data written before the owner field existed is kept and stamped with the current user", async () => {
        const store = configureAppStore(webrtc);
        await seedUserData(store);                               // no owner recorded
        expect(await getOwner()).toBeUndefined();

        expect(await ensureE2eeOwner("user-A")).toBe(false);

        expect(await getOwner()).toBe("user-A");
        expect(await signalMeta("deviceId")).toBe("device-A");
        expect(await loadPlaintext("m1")).toBe("meet at the old bridge at nine");
        expect(localStorage.getItem("wolp.e2eeVerified")).toContain("peer-1");
    });

    // Audit 2026-11-12, finding 6: with no network Kratos cannot end the session and the cookie is HttpOnly —
    // the app is asked to end it and to erase the cookies whatever the server said.
    it("in the Android app a logout without network still ends the session on the phone", async () => {
        const store = await loggedInStoreWithData();
        const fetchWas = globalThis.fetch;
        globalThis.fetch = vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
        const plugin = app.plugin;
        plugin.sessionEnd.mockResolvedValueOnce({ended: false});
        try {
            await fullLogout(store.dispatch);
        } finally { globalThis.fetch = fetchWas; }
        expect(plugin.sessionEnd).toHaveBeenCalledTimes(1);
        expect(plugin.e2eeWipe.mock.invocationCallOrder[0]).toBeLessThan(plugin.sessionEnd.mock.invocationCallOrder[0]);
    });

    it("a locked Vault in the Android app does not hold the logout up: nothing is decrypted", async () => {
        const store = await loggedInStoreWithData();
        const locked = () => Promise.reject(Object.assign(new Error("locked"), {code: "VAULT_LOCKED"}));
        const vault = {vaultWrap: vi.fn(locked), vaultUnwrap: vi.fn(locked)};
        const g = globalThis as {Capacitor?: unknown};
        g.Capacitor = {isNativePlatform: () => true, Plugins: {DeviceTrust: vault}};
        try {
            const done = await Promise.race([
                fullLogout(store.dispatch).then(() => "done"),
                new Promise((r) => setTimeout(() => r("hung"), 1500)),
            ]);
            expect(done).toBe("done");
        } finally { delete g.Capacitor; }

        expect(vault.vaultUnwrap).not.toHaveBeenCalled();
        expect(vault.vaultWrap).not.toHaveBeenCalled();
        await expectNothingLeft();
    });

    it("an expired session is not a logout: keys and history stay (scenario 1.7)", async () => {
        const store = await loggedInStoreWithData("user-A");

        store.dispatch(clearUser());                             // what the 401 handler does
        store.dispatch({type: "ws/disconnect"});
        // the same user logs in again
        expect(await ensureE2eeOwner("user-A")).toBe(false);

        expect(await signalMeta("deviceId")).toBe("device-A");
        expect(await loadPlaintext("m1")).toBe("meet at the old bridge at nine");
        expect(store.getState().secretChats.byId).toEqual({"c-secret": true});
        expect(app.plugin.e2eeWipe).not.toHaveBeenCalled();
    });
});
