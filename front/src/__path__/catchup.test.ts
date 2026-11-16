import {describe, it, expect, afterEach, vi} from "vitest";
import {act, render, renderHook} from "@testing-library/react";
import {createElement} from "react";
import {bench, stop, row, sealed, type BenchOptions} from "./bench";

// Spec 003, story 5 — the catch-up after a gap: a failed read of the open chat is tried again, the
// "unread" marks are not put on what the user is looking at, the server learns of a delivery only after
// the app has taken the message, and all of it works on every page the socket works on.

const MY = "me";
const PEER = "peer";
const CHAT = "c1";
const S1 = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const S2 = "01ARZ3NDEKTSV4RRFFQ69G5FA2";

type B = Awaited<ReturnType<typeof bench>>;

const msg = (id: string, body: string, o: {chat?: string; clientId?: string} = {}) =>
    row({id, chat: o.chat ?? CHAT, from: PEER, to: MY, body, clientId: o.clientId});
/** A direct chat with PEER as the server lists it; I have read nothing in it. */
const direct = (id: string) => ({id, clientId: MY, masterId: PEER, clientReadReceipt: null, updatedAt: "2026-11-15T10:00:00Z"});

const asked = (b: B, path: string) => b.server.requests().filter((r) => r.method === "GET" && r.path === path).length;
const listAsked = (b: B) => asked(b, "/chats");
const historyAsked = (b: B, chat = CHAT) => asked(b, `/chats/${chat}/messages?limit=200`);
const lastAsked = (b: B, chat: string) => asked(b, `/chats/${chat}/messages?limit=1`);
const unread = (b: B) => Object.keys(b.store.getState().chatUi.unreadByChat).sort();
const reading = (b: B, chat = CHAT) => b.m.history.selectChatHistory(b.store.getState(), chat)?.reading ?? 0;

async function signedIn(opts: BenchOptions = {}, chats: unknown[] = []): Promise<B> {
    const b = await bench(opts);
    b.server.chats(chats);
    await b.signIn(MY);
    return b;
}
/** Delivery as the application runs it: the hooks under the application's store. */
async function delivering(b: B) {
    const {useDelivery} = await import("@/features/chat/hooks/useDelivery");
    return renderHook(() => useDelivery(), {wrapper: b.wrapper});
}
/** The socket is lost and comes back. */
const reconnect = (b: B) => act(async () => { b.socket.drop(); b.socket.connect(); await b.tick(); });
/** The read of the chat that is on its way fails. */
const failRead = (b: B, chat = CHAT) => act(async () => {
    await b.server.history(chat).fail();
    await b.until(() => reading(b, chat) === 0, "the failed read to end");
});
const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("story 5: the catch-up after a gap", () => {
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); return stop(); });

    /** The chat is open and read; then the socket has a gap and the read after it fails. */
    async function failedAfterGap(): Promise<B> {
        const b = await signedIn();
        b.socket.connect();
        const chat = b.open(CHAT);
        await b.server.history(CHAT).answer([msg(S1, "first")]);
        await chat.read;
        await delivering(b);
        vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
        await reconnect(b);
        await failRead(b);
        expect(b.readFailed(CHAT)).toBe(true);
        return b;
    }

    it("5.1: a failed read of the open chat is tried again after 2, 4, 8 … 60 s, until it succeeds", async () => {
        const b = await failedAfterGap();
        for (const pause of [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
            const before = historyAsked(b);
            await pass(pause - 100);
            expect(historyAsked(b)).toBe(before);
            await pass(100);
            expect(historyAsked(b)).toBe(before + 1);
            expect(b.readFailed(CHAT)).toBe(true);                               // the line about the error stays
            await failRead(b);
        }
        await pass(60_000);
        await act(async () => {
            await b.server.history(CHAT).answer([msg(S1, "first"), msg(S2, "came in the gap")]);
            await b.until(() => reading(b) === 0, "the read to end");
        });
        expect(b.readFailed(CHAT)).toBe(false);
        expect(b.stale(CHAT)).toBe(false);
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([S1, S2]);

        const done = historyAsked(b);
        await pass(300_000);
        expect(historyAsked(b)).toBe(done);                                      // read: nothing more is asked
    });

    it("5.1: the retries stop when the user leaves the chat", async () => {
        const b = await failedAfterGap();
        const before = historyAsked(b);
        await act(async () => { b.store.dispatch(b.m.chatUi.setSelectedChatId(null)); });
        await pass(300_000);
        expect(historyAsked(b)).toBe(before);
    });

    it("5.1: the retries stop when the socket is lost, and start from 2 s on the next connection", async () => {
        const b = await failedAfterGap();
        await pass(2_000);
        await failRead(b);                                                       // the next pause would be 4 s
        const before = historyAsked(b);
        await act(async () => { b.socket.drop(); });
        await pass(300_000);
        expect(historyAsked(b)).toBe(before);

        await act(async () => { b.socket.connect(); await b.until(() => b.server.history(CHAT).waiting() === 1, "the read of the new connection"); });
        expect(historyAsked(b)).toBe(before + 1);                                // the read of the new connection
        await failRead(b);
        await pass(2_000);
        expect(historyAsked(b)).toBe(before + 2);
    });

    it("5.2: the unread check puts no mark on the chat the user has opened before the answer came", async () => {
        const b = await signedIn({}, [direct("c2"), direct("c3")]);
        await delivering(b);
        await act(async () => {
            b.socket.connect();
            await b.until(() => lastAsked(b, "c2") === 1 && lastAsked(b, "c3") === 1, "the unread check to ask both chats");
        });
        await act(async () => { b.open("c2"); });                                 // the user is in the chat now
        await act(async () => {
            await b.server.history("c2").answer([msg(S1, "new", {chat: "c2"})]);     // the answer to the check
            await b.server.history("c3").answer([msg(S2, "new", {chat: "c3"})]);
            await b.until(() => unread(b).includes("c3"), "the mark on the other chat");
            await b.settle();
        });
        expect(unread(b)).toEqual(["c3"]);
    });

    it("5.2: a chat that is selected while the page is hidden gets its mark", async () => {
        const b = await signedIn({}, [direct("c2")]);
        await delivering(b);
        await act(async () => {
            b.socket.connect();
            await b.until(() => lastAsked(b, "c2") === 1, "the unread check to ask the chat");
        });
        await act(async () => { b.open("c2"); b.page.hide(); });
        await act(async () => {
            await b.server.history("c2").answer([msg(S1, "new", {chat: "c2"})]);
            await b.until(() => unread(b).includes("c2"), "the mark");
        });
        expect(unread(b)).toEqual(["c2"]);
    });

    it("5.3: a new connection ends the unread check of the previous one; one new check runs", async () => {
        const chats = ["c1", "c2", "c3", "c4", "c5", "c6"];
        const b = await signedIn({}, chats.map(direct));
        await delivering(b);
        await act(async () => {
            b.socket.connect();
            await b.until(() => lastAsked(b, "c4") === 1, "the first check to ask four chats");
        });
        expect(chats.map((c) => lastAsked(b, c))).toEqual([1, 1, 1, 1, 0, 0]);    // four at a time

        await act(async () => {
            b.socket.drop();
            b.socket.connect();
            await b.until(() => lastAsked(b, "c4") === 2, "the second check to ask four chats");
        });
        // the answers of the first check come now: it asks nothing more and marks nothing
        await act(async () => {
            for (const c of chats.slice(0, 4)) await b.server.history(c).answer([msg(S1, "new", {chat: c})]);
            await b.settle(50);
        });
        expect(chats.map((c) => lastAsked(b, c))).toEqual([2, 2, 2, 2, 0, 0]);
        expect(unread(b)).toEqual([]);

        // the second check runs to its end
        await act(async () => {
            for (const c of chats.slice(0, 4)) await b.server.history(c).answer([msg(S1, "new", {chat: c})]);
            for (const c of chats.slice(4)) await b.server.history(c).answer([msg(S1, "new", {chat: c})]);
            await b.until(() => unread(b).length === 6, "all six marks");
            await b.settle(50);
        });
        expect(chats.map((c) => lastAsked(b, c))).toEqual([2, 2, 2, 2, 1, 1]);
        expect(listAsked(b)).toBe(2);                                            // one list per connection
    });

    describe("5.4: the server is told of a delivery after the app has taken the message", () => {
        const acks = (b: B) => b.socket.sent("CHAT_ACK").map((f) => f.correlationId ?? f.messageId);

        async function inApp(): Promise<B> {
            const b = await signedIn({app: true});
            b.socket.connect();
            return b;
        }

        it("5.4: the app answered — the confirmation goes out", async () => {
            const b = await inApp();
            b.socket.frame(msg(S1, "hello"));
            expect(b.socket.sent("CHAT_ACK")).toEqual([]);                        // not before the answer
            await b.until(() => b.socket.sent("CHAT_ACK").length === 1, "the confirmation");
            expect(b.app.notified().map((n) => n.messageId)).toEqual([S1]);
        });

        it("5.4: the app refused — no confirmation; the same message sent again is confirmed and is one row", async () => {
            const b = await inApp();
            b.app.notify("refuses");
            b.socket.frame(msg(S1, "hello"));
            await b.settle(50);
            expect(b.socket.sent("CHAT_ACK")).toEqual([]);

            b.app.notify("answers");
            b.socket.frame(msg(S1, "hello"));                                    // the server sends it again
            await b.until(() => b.socket.sent("CHAT_ACK").length === 1, "the confirmation");
            expect(acks(b)).toHaveLength(1);
            // no chat is open: the user is not looking at this one — the app may show it (spec 002 §5, case 5)
            expect(b.app.notified().map((n) => [n.messageId, n.hidden])).toEqual([[S1, true], [S1, true]]);
        });

        it("5.4: the app is silent for longer than 2 s — no confirmation, then or later", async () => {
            const b = await inApp();
            b.app.notify("silent");
            vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
            b.socket.frame(msg(S1, "hello"));
            await vi.advanceTimersByTimeAsync(2_000);
            expect(b.socket.sent("CHAT_ACK")).toEqual([]);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(b.socket.sent("CHAT_ACK")).toEqual([]);
            expect(b.app.notified()).toHaveLength(1);
        });

        it("5.4: an app without the method (before 10191) — the confirmation goes out at once", async () => {
            const b = await inApp();
            b.app.notify("absent");
            b.socket.frame(msg(S1, "hello"));
            expect(b.socket.sent("CHAT_ACK")).toHaveLength(1);
        });

        it("5.4: a browser — the confirmation goes out at once", async () => {
            const b = await signedIn();
            b.socket.connect();
            b.socket.frame(msg(S1, "hello"));
            expect(b.socket.sent("CHAT_ACK")).toHaveLength(1);
        });
    });

    describe("5.5: the queue goes out and the marks are asked on every page", () => {
        const send = (b: B, text: string) =>
            b.m.service.chatMessagesService.enqueueChatMessage(b.store.dispatch, text, MY, "c2", PEER, undefined, false) as Promise<unknown>;
        /** The server accepts the connection once the application asks for it. */
        /** Waits for the page: what React has to draw first (the page's code, a new state) is drawn between the looks. */
        async function shown(b: B, check: () => boolean, what: string, ms = 20_000): Promise<void> {
            for (let waited = 0; !check(); waited += 20) {
                if (waited >= ms) throw new Error(`waited ${ms} ms for ${what}`);
                await act(async () => { await b.settle(20); });
            }
        }
        /** The server accepts the connection once the application asks for it. */
        const accept = (b: B) => shown(b, () => {
            if (b.socket.isOpen()) return true;
            try { b.socket.accept(); return true; } catch { return false; }
        }, "the application to connect");

        afterEach(() => window.history.pushState({}, "", "/"));

        it.each([
            ["the main page", "/"],
            ["'add a contact'", "/add"],
            ["'new group'", "/new-group"],
            ["'settings'", "/settings"],
        ])("5.5: on %s", async (_name, path) => {
            const b = await signedIn({}, [direct("c2")]);
            b.server.history("c2").always([msg(S1, "new", {chat: "c2"})]);
            window.history.pushState({}, "", path);
            const {default: App} = await import("@/app/App");
            const view = render(createElement(b.wrapper, null, createElement(App)));
            try {
                await accept(b);
                await shown(b, () => lastAsked(b, "c2") === 1 && unread(b).includes("c2"), "the unread check of the first connection");

                await act(async () => { b.socket.drop(); await b.tick(); });
                await act(async () => { await send(b, "written with no connection"); });
                expect(b.socket.sent("CHAT_IN")).toEqual([]);

                await act(async () => { b.socket.connect(); await b.tick(); });
                await shown(b, () => b.socket.sent("CHAT_IN").length === 1, "the queue to go out", 3_000);
                await shown(b, () => lastAsked(b, "c2") === 2, "the unread check of the second connection", 3_000);
                expect(listAsked(b)).toBeGreaterThanOrEqual(2);
            } finally {
                view.unmount();
            }
        }, 30_000);
    });

    describe("5.6: a secret message is decrypted once", () => {
        const secret = (id: string, text: string, clientId: string) => msg(id, sealed(text), {clientId});
        const texts = (b: B) => b.screen(CHAT)?.map((m) => m.text);
        const sentTypes = (b: B) => [...new Set(b.socket.sent().map((f) => f.type))].sort();
        // Ids of messages stored a moment ago: an old message is "expired" and is not decrypted at all.
        const fresh = (agoMs: number, tail: string) => {
            let at = Date.now() - agoMs, time = "";
            for (let i = 0; i < 10; i++) { time = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[at % 32] + time; at = Math.floor(at / 32); }
            return time + tail.padStart(16, "0");
        };
        const S1 = fresh(2_000, "1");
        const S2 = fresh(1_000, "2");

        it("5.6: it comes over the socket while the history is being read", async () => {
            const b = await signedIn({app: true});
            b.socket.connect();
            const chat = b.open(CHAT);                                           // the read is on its way
            b.socket.frame(secret(S1, "for your eyes", "k1"));
            await b.server.history(CHAT).answer([secret(S1, "for your eyes", "k1")]);
            await chat.read;
            await b.until(() => texts(b)?.[0] === "for your eyes", "the text");
            await b.settle(100);

            expect(b.app.decrypted()).toHaveLength(1);
            expect(texts(b)).toEqual(["for your eyes"]);
            expect(sentTypes(b)).toEqual(["CHAT_ACK", "READ_IN"]);               // the sender is asked for nothing
        });

        it("5.6: the history is read first and the message comes over the socket right after", async () => {
            const b = await signedIn({app: true});
            b.socket.connect();
            const chat = b.open(CHAT);
            await b.server.history(CHAT).answer([secret(S1, "for your eyes", "k1")]);
            await chat.read;
            b.socket.frame(secret(S1, "for your eyes", "k1"));
            await b.until(() => texts(b)?.[0] === "for your eyes", "the text");
            await b.settle(100);

            expect(b.app.decrypted()).toHaveLength(1);
            expect(texts(b)).toEqual(["for your eyes"]);
            expect(sentTypes(b)).toEqual(["CHAT_ACK", "READ_IN"]);
        });

        it("5.6: the same frame twice in a row (its confirmation was lost)", async () => {
            const b = await signedIn({app: true});
            b.socket.connect();
            const chat = b.open(CHAT);
            await b.server.history(CHAT).answer([]);
            await chat.read;
            b.socket.frame(secret(S1, "for your eyes", "k1"));
            b.socket.frame(secret(S1, "for your eyes", "k1"));
            await b.until(() => texts(b)?.[0] === "for your eyes", "the text");
            await b.settle(100);

            expect(b.app.decrypted()).toHaveLength(1);
            expect(texts(b)).toEqual(["for your eyes"]);
            expect(sentTypes(b)).toEqual(["CHAT_ACK", "READ_IN"]);
        });

        it("5.6: two messages of one peer are decrypted in the order they came", async () => {
            const b = await signedIn({app: true});
            b.socket.connect();
            const chat = b.open(CHAT);
            await b.server.history(CHAT).answer([]);
            await chat.read;
            b.socket.frame(secret(S1, "one", "k1"));
            b.socket.frame(secret(S2, "two", "k2"));
            await b.until(() => texts(b)?.join() === "one,two", "both texts");
            expect(b.app.decrypted()).toEqual([sealed("one"), sealed("two")]);
        });
    });

    describe("5.7: one request of each kind per connection", () => {
        /** The chat is open and read, the other chat is in the list; delivery runs. */
        async function open(): Promise<B> {
            const b = await signedIn({}, [direct(CHAT), direct("c2")]);
            b.server.history(CHAT).always([msg(S1, "first")]);
            b.server.history("c2").always([]);
            b.socket.connect();
            await b.open(CHAT).read;
            await delivering(b);
            await act(async () => { await b.until(() => lastAsked(b, "c2") === 1, "the unread check of the first connection"); await b.settle(); });
            return b;
        }

        it("5.7: back on the screen with the socket still closed — the history is asked once, after the connection", async () => {
            const b = await open();
            await act(async () => { b.page.hide(); b.socket.drop(); await b.tick(); });
            const [history, list] = [historyAsked(b), listAsked(b)];

            await act(async () => { b.page.show(); await b.settle(50); });
            expect(historyAsked(b)).toBe(history);                               // nothing to prove the chat complete with
            expect(listAsked(b)).toBe(list);

            await act(async () => { b.socket.connect(); await b.settle(100); });
            expect(historyAsked(b)).toBe(history + 1);
            expect(listAsked(b)).toBe(list + 1);
            expect(b.stale(CHAT)).toBe(false);
        });

        it("5.7: a new connection asks the list once, the open chat once and each other chat's last message once", async () => {
            const b = await open();
            const before = [listAsked(b), historyAsked(b), lastAsked(b, "c2"), lastAsked(b, CHAT)];
            await reconnect(b);
            await act(async () => { await b.settle(100); });
            expect([listAsked(b), historyAsked(b), lastAsked(b, "c2"), lastAsked(b, CHAT)])
                .toEqual([before[0] + 1, before[1] + 1, before[2] + 1, before[3]]);
        });

        it("5.7: back on the screen with a living socket — the list and the open chat are asked once each", async () => {
            const b = await open();
            await act(async () => { b.page.hide(); });
            const before = [listAsked(b), historyAsked(b)];
            await act(async () => { b.page.show(); await b.settle(100); });
            expect([listAsked(b), historyAsked(b)]).toEqual([before[0] + 1, before[1] + 1]);
        });
    });
});
