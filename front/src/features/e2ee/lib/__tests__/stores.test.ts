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
                if (!/^E2EE_DB\.\w+$/.test(arg)) offenders.push(`${path}: openDB(${arg}`);
            }
            if (/indexedDB\.open\(/.test(text)) offenders.push(`${path}: raw indexedDB.open`);
        }
        expect(offenders).toEqual([]);
        // Three places open a database. The fourth name, e2ee-device, was the wrapping key of older browser
        // versions: nothing opens it any more, it stays in the list so that a logout erases it.
        expect(opens).toBe(E2EE_DATABASES.length - 1);
    });

    it("no JavaScript implementation of the keys is left in the feature", () => {
        for (const gone of ["signalStore.ts", "secretSession.ts", "provisioning.ts", "keyDirectory.ts", "browserCrypto.ts"]) {
            expect(files.some((f) => f.path.endsWith(gone))).toBe(false);
        }
        for (const {path, text} of files) {
            expect(text, path).not.toMatch(/libsignal-protocol-typescript/);
            expect(text, path).not.toMatch(/crypto\.subtle/);
            expect(text, path).not.toMatch(/key-directory\/v1\/keys/);
        }
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
