import "fake-indexeddb/auto";
import {describe, it, expect, beforeEach} from "vitest";
import {sweepRenamedStores, LOCAL_STORES, DB_STORES} from "../renamedStores";
import {sources as allSources} from "virtual:repo-text";

const sources = Object.fromEntries(Object.entries(allSources).filter(([p]) => !p.endsWith(".css")));
const storesSource = allSources["/src/features/e2ee/lib/stores.ts"];
const open = (name: string) => new Promise<void>((res) => { const r = indexedDB.open(name, 1); r.onsuccess = () => { r.result.close(); res(); }; });
const dbNames = async () => (await indexedDB.databases()).map((d) => d.name).sort();

describe("stores renamed to the product prefix", () => {
    beforeEach(() => { localStorage.clear(); });

    it("removes what an earlier build left in localStorage and keeps the current stores", async () => {
        localStorage.setItem("old.drafts.v1", '{"c1":"a draft"}');
        localStorage.setItem("old.secretChats", '{"c1":true}');
        localStorage.setItem("old.e2eeVerified", "{}");
        localStorage.setItem("wolp.drafts.v1", '{"c2":"current"}');
        localStorage.setItem("wolp.secretChats", '{"c2":true}');
        localStorage.setItem("i18nextLng", "es");              // somebody else's key
        localStorage.setItem("other.app.drafts.v1", "x");      // not "<prefix>.<store>"
        await sweepRenamedStores();
        expect(Object.keys(localStorage).sort()).toEqual(["i18nextLng", "other.app.drafts.v1", "wolp.drafts.v1", "wolp.secretChats"]);
    });

    it("removes the earlier build's databases and keeps the current ones and the E2EE ones", async () => {
        for (const n of ["old-names", "old-pending-call", "old-push-dedup", "wolp-names", "e2ee-signal", "chatDB"]) await open(n);
        await sweepRenamedStores();
        expect(await dbNames()).toEqual(["chatDB", "e2ee-signal", "wolp-names"]);
    });

    it("every store named in the code with the product prefix is in the list", () => {
        const all = Object.entries(sources).filter(([p]) => !p.includes("__tests__")).map(([, s]) => s).join("\n") + storesSource;
        const local = [...all.matchAll(/"wolp\.([A-Za-z0-9.-]+)"/g)].map((m) => m[1]);
        const dbs = [...all.matchAll(/"wolp-([a-z-]+)"/g)].map((m) => m[1]).filter((n) => n !== "e2ee-ratchet");   // a Web Lock, not a store
        expect(local.length).toBeGreaterThan(3);
        for (const n of local) expect(LOCAL_STORES).toContain(n);
        for (const n of dbs) expect(DB_STORES).toContain(n);
    });
});
