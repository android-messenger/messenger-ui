import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";
import {wipeAllStorage} from "../wipeStorage.ts";

// Records every deleteDatabase call and resolves its request asynchronously (mirrors the real onsuccess).
function fakeIndexedDB(enumerated: string[] | null) {
    const deleted: string[] = [];
    const idb = {
        deleteDatabase: (name: string) => {
            deleted.push(name);
            const req: {onsuccess?: () => void; onerror?: () => void; onblocked?: () => void} = {};
            setTimeout(() => req.onsuccess?.(), 0);
            return req;
        },
        ...(enumerated ? {databases: async () => enumerated.map((name) => ({name}))} : {}),
    };
    return {idb, deleted};
}

const cacheDelete = vi.fn(async () => true);
const swUnregister = vi.fn(async () => true);

beforeEach(() => {
    localStorage.setItem("wolp.sticky", "x");
    sessionStorage.setItem("tmp", "y");
    vi.stubGlobal("caches", {keys: async () => ["app-shell", "runtime"], delete: cacheDelete});
    Object.defineProperty(navigator, "serviceWorker", {
        configurable: true, value: {getRegistrations: async () => [{unregister: swUnregister}]},
    });
    cacheDelete.mockClear(); swUnregister.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("wipeAllStorage", () => {
    it("deletes enumerated + known databases, clears web storage, caches, and the service worker", async () => {
        const {idb, deleted} = fakeIndexedDB(["e2ee-device", "some-extra-db"]);
        vi.stubGlobal("indexedDB", idb);

        await wipeAllStorage();

        // union of enumerated and the known list — the device/master key and an unexpected extra both go
        expect(deleted).toContain("e2ee-device");
        expect(deleted).toContain("some-extra-db");
        expect(deleted).toContain("e2ee-signal");
        expect(deleted).toContain("chatDB");
        expect(deleted).toContain("wolp-push-dedup");
        expect(new Set(deleted).size).toBe(deleted.length);   // no dup deletes

        expect(localStorage.getItem("wolp.sticky")).toBeNull();
        expect(sessionStorage.getItem("tmp")).toBeNull();
        expect(cacheDelete).toHaveBeenCalledWith("app-shell");
        expect(cacheDelete).toHaveBeenCalledWith("runtime");
        expect(swUnregister).toHaveBeenCalledTimes(1);
    });

    it("falls back to the known list when indexedDB.databases() is unavailable (Firefox)", async () => {
        const {idb, deleted} = fakeIndexedDB(null);   // no .databases()
        vi.stubGlobal("indexedDB", idb);
        await wipeAllStorage();
        expect(deleted).toContain("e2ee-device");
        expect(deleted).toContain("e2ee-recovery");
        expect(deleted).toContain("wolp-names");
    });

    it("never throws when stores are missing/broken", async () => {
        vi.stubGlobal("indexedDB", {deleteDatabase: () => { throw new Error("blocked"); }, databases: async () => { throw new Error("nope"); }});
        vi.stubGlobal("caches", {keys: async () => { throw new Error("no caches"); }, delete: cacheDelete});
        await expect(wipeAllStorage()).resolves.toBeUndefined();
    });
});
