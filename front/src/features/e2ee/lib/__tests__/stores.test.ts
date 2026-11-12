// @vitest-environment node
import {describe, it, expect} from "vitest";
import {E2EE_DATABASES} from "../stores";

// Spec 001, FR-002: every database the E2EE feature opens is in the one list that logout and the panic
// wipe erase. A database opened under a name that is not taken from lib/stores.ts fails here — before it
// can survive a logout.

// Source text of every non-test module of features/e2ee, keyed by its path (files of lib/ by bare name).
const raw = import.meta.glob<string>(["../../**/*.ts", "../../**/*.tsx", "!../../**/__tests__/**"], {query: "?raw", import: "default", eager: true});
const files = Object.entries(raw).map(([path, text]) => ({path: path.replace(/^(\.\.\/)+/, ""), text}));

describe("E2EE stores list", () => {
    it("every openDB in features/e2ee takes its name from lib/stores.ts", () => {
        const offenders: string[] = [];
        let opens = 0;
        expect(files.length).toBeGreaterThan(10);                // the glob really found the feature
        for (const {path, text} of files) {
            for (const m of text.matchAll(/openDB\(\s*([^,)]+)/g)) {
                opens++;
                const arg = m[1].trim();
                // E2EE_DB.<name>, or the SignalStore's own name whose default is E2EE_DB.signal (below)
                if (!/^E2EE_DB\.\w+$/.test(arg) && arg !== "this.dbName") offenders.push(`${path}: openDB(${arg}`);
            }
            if (/indexedDB\.open\(/.test(text)) offenders.push(`${path}: raw indexedDB.open`);
        }
        expect(offenders).toEqual([]);
        expect(opens).toBe(E2EE_DATABASES.length);               // four databases, four places that open them
    });

    it("the SignalStore opens the listed database by default", () => {
        const text = files.find((f) => f.path === "signalStore.ts")?.text;
        expect(text).toMatch(/constructor\(dbName: string = E2EE_DB\.signal\)/);
    });

    it("no database name is written out anywhere else in the feature", () => {
        const offenders: string[] = [];
        for (const {path, text} of files) {
            if (path === "stores.ts") continue;
            // `const DB = "…"` is how a module used to name its own database
            for (const m of text.matchAll(/const\s+DB\w*\s*=\s*["'`]([^"'`]+)["'`]/g)) offenders.push(`${path}: ${m[1]}`);
        }
        expect(offenders).toEqual([]);
    });
});
