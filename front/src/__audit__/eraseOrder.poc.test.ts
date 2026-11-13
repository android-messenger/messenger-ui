import "fake-indexeddb/auto";
import {describe, it, expect, vi, afterEach} from "vitest";
import {installFakeApp} from "@/features/e2ee/lib/__tests__/fakeApp.ts";
import {abortVaultWaits} from "@/features/e2ee/lib/deviceKey.ts";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema";
import {HISTORY_STORE_NAME} from "@/shared/config/idb";

// Audit 2026-11-13, apps-delta. "Erase everything" (InfoModal.doWipe) = fullLogout() and only then
// wipeAllStorage(). fullLogout does its network steps first; nothing on the device is erased until they end.

vi.mock("@/features/auth/model/services/kratosFlows.ts", () => ({
    logout: () => new Promise<string>((_r, reject) => setTimeout(() => reject(new Error("timeout")), 10_000)),   // kratos.ts: timeout 10000
}));

describe("apps-delta PoC: order of 'Erase everything'", () => {
    let app: ReturnType<typeof installFakeApp>;
    afterEach(() => { abortVaultWaits(); app.uninstall(); });

    it("F2: 5 s after the button was pressed on a network that does not answer, the cache and the stored secret texts are all still on disk", async () => {
        app = installFakeApp();
        (app.plugin as Record<string, unknown>).e2eeWipe = vi.fn(() => new Promise(() => {}));   // the library waits for the key directory
        const db = await import("@/features/chat/db/db");
        const atRest = await import("@/features/e2ee/lib/atRest");
        const {fullLogout} = await import("@/features/auth/model/services/fullLogout");
        const {wipeAllStorage} = await import("@/features/diagnostics/wipeStorage");
        await db.saveHistoryToDB("c1", [{id: "m1", text: "plain history"}] as unknown as ChatMessage[]);
        await db.saveAttachmentBlob("att-1", new Blob(["PHOTO"]));
        expect(await atRest.savePlaintext("s1", "c2", "secret text")).toBe(true);

        const dispatched: unknown[] = [];
        const dispatch = ((a: unknown) => { dispatched.push(a); return a; }) as never;
        let wiped = false;
        void fullLogout(dispatch).then(() => wipeAllStorage()).then(() => { wiped = true; });   // InfoModal.tsx:120-127

        await new Promise((r) => setTimeout(r, 5_000));
        expect(wiped).toBe(false);
        expect(dispatched).toHaveLength(0);                                     // logoutResetClientState not reached
        const d = await db.initDB();
        expect(await d.get(HISTORY_STORE_NAME, "c1")).toBeDefined();
        expect(await db.loadAttachmentBlob("att-1")).not.toBeNull();           // unencrypted attachment
        expect(await atRest.loadPlaintext("s1")).toBe("secret text");
        expect(localStorage.getItem("wolp.e2eeWipePending")).toBeNull();        // and no mark that would finish the job on the next start
    }, 15_000);
});
