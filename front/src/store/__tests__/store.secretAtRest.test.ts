import "fake-indexeddb/auto";
import {describe, it, expect, beforeEach} from "vitest";

import {configureAppStore, hydrateStore} from "../store";
import {initDB, clearAllLocalData} from "@/features/chat/db/db";
import {HISTORY_STORE_NAME} from "@/shared/config/idb";
import {markSecret} from "@/features/chat/model/slices/secretChatsSlice";
import {clearAllDrafts, saveDraft} from "@/features/chat/model/drafts";
import type {WebRTCService} from "@/features/call/service/webRTCService";

// F1 work 1: what startup and the "secret" toggle do to plaintext an earlier client version (or an
// earlier, non-secret mode of the chat) left on disk.

const DRAFTS_KEY = "wolp.drafts.v1";
const webrtc = {setSendCallback: () => {}, setEventCallbacks: () => {}} as unknown as WebRTCService;

async function waitFor(check: () => Promise<boolean>) {
    for (let i = 0; i < 200; i++) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("condition not reached");
}

describe("store — secret-chat plaintext is removed from disk", () => {
    beforeEach(async () => {
        clearAllDrafts();
        localStorage.clear();
        await clearAllLocalData();
    });

    it("hydrateStore scrubs the history cache and drops the persisted drafts of secret chats", async () => {
        const db = await initDB();
        await db.put(HISTORY_STORE_NAME, [
            {id: "p1", text: "an ordinary message"},
            {id: "s1", text: "meet at the old bridge at nine", secret: true},
        ], "c-secret");
        localStorage.setItem("wolp.secretChats", JSON.stringify({"c-secret": true}));
        saveDraft("c-secret", "unsent secret words");
        saveDraft("c-plain", "unsent ordinary words");

        await hydrateStore(configureAppStore(webrtc));

        expect(localStorage.getItem(DRAFTS_KEY)).not.toContain("unsent secret words");
        expect(localStorage.getItem(DRAFTS_KEY)).toContain("unsent ordinary words");
        await waitFor(async () => ((await db.get(HISTORY_STORE_NAME, "c-secret")) as unknown[]).length === 1);
        expect(await db.get(HISTORY_STORE_NAME, "c-secret")).toEqual([{id: "p1", text: "an ordinary message"}]);
    });

    it("turning secret mode on drops that chat's persisted draft", () => {
        const store = configureAppStore(webrtc);
        saveDraft("c1", "typed before going secret");
        saveDraft("c2", "ordinary");

        store.dispatch(markSecret("c1"));

        expect(localStorage.getItem(DRAFTS_KEY)).not.toContain("typed before going secret");
        expect(localStorage.getItem(DRAFTS_KEY)).toContain("ordinary");
    });
});
