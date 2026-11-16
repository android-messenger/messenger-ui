import {describe, it, expect, afterEach, vi} from "vitest";
import {act, renderHook} from "@testing-library/react";
import {sources} from "virtual:repo-text";
import {bench, stop, row} from "./bench";

import {dedupMessages} from "@/features/chat/model/reconcileHistory";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema";
import {chatOnScreen, pageHidden} from "@/features/chat/model/onScreen";

// Spec 003, story 6 (FR-050 … FR-054): one rule — one place. Behaviour does not change in this story: the
// tests of stories 1–5 hold it. These tests hold where the rules are written.

/** The source text without comments: a rule named in a comment is not a second copy of it. */
const code = (path: string) => sources[path]
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** The application's own files (no tests, no test helpers) under these directories. */
const filesUnder = (...dirs: string[]) => Object.keys(sources).filter((p) =>
    dirs.some((d) => p.startsWith(d)) && /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.includes("/__path__/"));

const msgRow = (id: string, clientId?: string): ChatMessage =>
    ({id, clientId, chatId: "c", from: "u", text: id, createdAt: new Date(0)}) as ChatMessage;

describe("one rule — one place", () => {
    it("6.1: \"the same message\" is one function, and the places that told messages apart call it", () => {
        // Comparing the sender's client id outside historyCache is a second rule of "the same message".
        const compares = /clientId\s*[!=]==|[!=]==\s*[\w.?]*clientId\b|clientId\s*\|\|/;
        const elsewhere = filesUnder("/src/features/chat/", "/src/features/e2ee/")
            .filter((p) => p !== "/src/features/chat/model/historyCache.ts")
            .filter((p) => compares.test(code(p)));
        expect(elsewhere).toEqual([]);

        // The five places of the audit (§5): the history slice, the merge of an answer, a page of the server,
        // deleting a row; the fifth — the echo matched by its text in chatApi — is gone since story 3.
        for (const p of [
            "/src/features/chat/model/slices/chatHistorySlice.ts",
            "/src/features/chat/model/mergeHistory.ts",
            "/src/features/chat/model/reconcileHistory.ts",
            "/src/features/chat/rest/chatApi.ts",
        ]) expect(code(p), p).toMatch(/\b(sameMessage|hasMessage|upsertMessage)\(/);
        expect(code("/src/features/chat/model/historyCache.ts")).toMatch(/export function sameMessage\(/);
    });

    it("6.1: a page of the server keeps one row per message, by either id", () => {
        const page = [msgRow("01A", "c1"), msgRow("01B", "c1"), msgRow("c2"), msgRow("01C", "c2"), msgRow("01A"), msgRow("01D", "01E"), msgRow("01E")];
        expect(dedupMessages(page).map((m) => m.id)).toEqual(["01A", "c2", "01D"]);
    });

    it("6.2: \"the user is looking at this chat\" and \"a message can be sent now\" are one function each", () => {
        const chat = filesUnder("/src/features/chat/");
        // Whether the page is on the screen is asked in onScreen.ts only. A video that pauses when the page
        // is hidden is about the video, not about a chat.
        const visibility = /document\.hidden|visibilityState/;
        expect(chat.filter((p) => visibility.test(code(p)))
            .filter((p) => !["/src/features/chat/model/onScreen.ts", "/src/features/chat/ui/AttachmentVideo.tsx"].includes(p))).toEqual([]);
        // The refusal "the lists are not read yet" is said in one place: mayQueue. A missed-call note is not
        // the user's message — it is skipped without a word, so it asks listsReady itself.
        expect(chat.filter((p) => /LISTS_NOT_READY_KEY/.test(code(p)) && p !== "/src/features/chat/model/sealedLists.ts")).toEqual([]);
        expect(chat.filter((p) => /\blistsReady\(\)/.test(code(p)))
            .filter((p) => !["/src/features/chat/model/sealedLists.ts", "/src/features/chat/hooks/useMissedCallNote.ts"].includes(p))).toEqual([]);
        for (const p of [
            "/src/features/chat/hooks/useMessageComposer.ts",
            "/src/features/chat/hooks/useChatAttachments.ts",
            "/src/features/chat/model/services/chatMessages.service.ts",
        ]) expect(code(p), p).toMatch(/\bmayQueue\(\)/);

        let hidden = false;
        Object.defineProperty(document, "hidden", {configurable: true, get: () => hidden});
        try {
            expect(chatOnScreen("c1")).toBe("c1");
            expect(chatOnScreen(null)).toBeNull();
            hidden = true;
            expect(pageHidden()).toBe(true);
            expect(chatOnScreen("c1")).toBeNull();
        } finally {
            delete (document as unknown as Record<string, unknown>).hidden;
        }
    });
});

describe("the state of delivery lives in the store", () => {
    afterEach(() => { vi.restoreAllMocks(); return stop(); });

    const MY = "me";
    const CHAT = "c1";
    type B = Awaited<ReturnType<typeof bench>>;
    const delivery = (b: B) => b.store.getState().delivery;

    /** Signed in, the socket connected, the catch-up ran under this connection and the chat was read. */
    async function caughtUp(): Promise<B> {
        const b = await bench();
        b.server.chats([]);
        await b.signIn(MY);
        const {useDelivery} = await import("@/features/chat/hooks/useDelivery");
        renderHook(() => useDelivery(), {wrapper: b.wrapper});
        await act(async () => { b.socket.connect(); });
        const under = b.store.getState().ws.epoch;
        const chat = b.open(CHAT);
        await b.server.history(CHAT).answer([row({id: "01ARZ3NDEKTSV4RRFFQ69G5FA1", chat: CHAT, from: "peer", to: MY, body: "hi"})]);
        await chat.read;
        await b.until(() => delivery(b).unreadAskedUnder === under, "the unread marks to be asked");
        expect(b.m.history.isStale(b.store.getState(), CHAT)).toBe(false);
        return b;
    }

    it("6.4: a 401 forgets the connection the marks were asked under; the history read under it is stale", async () => {
        const b = await caughtUp();
        b.server.expireSession();
        await act(async () => {
            await b.store.dispatch(b.m.api.chatApi.endpoints.getChats.initiate({myId: MY}, {subscribe: false, forceRefetch: true}));
            await b.settle();
        });
        expect(b.store.getState().user.id).not.toBe(MY);
        expect(delivery(b).unreadAskedUnder).toBeNull();
        expect(b.m.history.isStale(b.store.getState(), CHAT)).toBe(true);
        expect(delivery(b).listsReady).toBe(true);                           // a browser: the lists are read at once
    });

    it("6.4: a sign-out forgets the connection the marks were asked under and the chat's history", async () => {
        const b = await caughtUp();
        await act(async () => { b.store.dispatch(b.m.logout.logoutResetClientState()); await b.settle(); });
        expect(delivery(b).unreadAskedUnder).toBeNull();
        expect(b.m.history.selectChatHistory(b.store.getState(), CHAT)).toBeUndefined();
        expect(b.m.history.isStale(b.store.getState(), CHAT)).toBe(true);
    });

    it("6.4: whether the sealed lists are read is the store's: a new start of the app on a locked phone has them not read", async () => {
        const b = await bench({app: true});
        expect(delivery(b).listsReady).toBe(true);
        expect(b.m.lists.listsReady()).toBe(true);
        b.app.lock();
        const again = await b.restart({settled: false});
        expect(delivery(again).listsReady).toBe(false);
        expect(again.m.lists.listsReady()).toBe(false);
        again.app.unlock();
        await again.until(() => delivery(again).listsReady, "the lists to be read after the unlock");
    });
});
