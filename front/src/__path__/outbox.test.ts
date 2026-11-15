import {describe, it, expect, afterEach, vi} from "vitest";
import {act, renderHook} from "@testing-library/react";
import {bench, stop, row, type BenchOptions} from "./bench";

// Spec 003, story 3 — what the user wrote is either sent, or in the send queue and on the screen, or still
// in the input field. The end of a session, a restart and a refusal to encrypt do not change that; the
// queue of one account is never sent under another.

const MY = "me";
const PEER = "peer";
const CHAT = "c1";
const M1 = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
/** The two kinds of disk: a browser keeps the records open, the Android app seals them with the Vault. */
const DISKS: Array<[string, BenchOptions]> = [["browser", {}], ["app", {app: true}]];

type B = Awaited<ReturnType<typeof bench>>;

/** The user sends `text` into the chat: the same call the input field makes. Resolves to true if it was queued. */
function send(b: B, text: string, o: {chat?: string; secret?: boolean; to?: string; meta?: Record<string, string>} = {}) {
    return b.m.service.chatMessagesService.enqueueChatMessage(
        b.store.dispatch, text, MY, o.chat ?? CHAT, o.to ?? PEER, undefined, o.secret ?? false, o.meta) as Promise<unknown>;
}
const ids = (b: B) => b.queue().map((m) => m.id);
const texts = (b: B) => b.queue().map((m) => m.payload.payload?.body);
/** The CHAT_IN frames that went to the server: the client ids, in order. */
const sentIds = (b: B) => b.socket.sent("CHAT_IN").map((f) => f.messageId);

/** Waits until the queue on the disk holds exactly these messages (the app never waits for a write). */
async function onDisk(b: B, want: string[]): Promise<void> {
    let found: string[] = [];
    for (let i = 0; i < 300; i++) {
        found = ((await b.m.db.loadOutboxFromDB())?.messages ?? []).map((m) => m.id);
        if (JSON.stringify(found) === JSON.stringify(want)) return;
        await b.settle(5);
    }
    expect(found).toEqual(want);
}

/** The session ends without a sign-out: the next request gets a 401. */
async function sessionExpires(b: B, me: string): Promise<void> {
    b.server.expireSession();
    await b.store.dispatch(b.m.api.chatApi.endpoints.getChats.initiate({myId: me}, {subscribe: false, forceRefetch: true}));
    await b.settle();
}

/** The socket connects and the queue is sent, as on every connection. */
async function connectAndFlush(b: B): Promise<void> {
    b.socket.connect();
    await b.store.dispatch(b.m.flush.flushOutbox());
}

describe("story 3: what is not sent yet is not lost", () => {
    afterEach(() => { vi.restoreAllMocks(); return stop(); });

    // Was A3 of the audit: any 401 emptied the queue, and the empty queue went to the disk.
    it.each(DISKS)("3.1: a 401 does not touch the send queue; the same user signs in again and it is sent (%s)", async (_disk, opts) => {
        const b = await bench(opts);
        await b.signIn(MY);
        await send(b, "written without a connection");
        await send(b, "and one more");
        const queued = ids(b);
        expect(queued).toHaveLength(2);
        await onDisk(b, queued);

        await sessionExpires(b, MY);
        expect(b.store.getState().user.id).not.toBe(MY);                         // signed out by the 401
        await b.settle(500);                                                     // longer than the delay of the write
        expect(ids(b)).toEqual(queued);
        await onDisk(b, queued);

        await b.signIn(MY);
        await connectAndFlush(b);
        expect(sentIds(b)).toEqual(queued);
    });

    it.each(DISKS)("3.1: a 401, a restart, the same user signs in — the queue is read from the disk and sent (%s)", async (_disk, opts) => {
        const first = await bench(opts);
        await first.signIn(MY);
        await send(first, "written without a connection");
        const queued = ids(first);
        await onDisk(first, queued);
        await sessionExpires(first, MY);
        await first.settle(500);

        const b = await first.restart();
        await b.signIn(MY);
        expect(ids(b)).toEqual(queued);
        await connectAndFlush(b);
        expect(sentIds(b)).toEqual(queued);
    });

    // Was A7 of the audit (finding 9): the queue was read at the start, before anyone knew whose session
    // this is; the owner check erased the disk, the queue in memory stayed and was sent under the new account.
    it.each(DISKS)("3.2: the queue of another account is erased on the disk and in memory, and nothing of it is sent (%s)", async (_disk, opts) => {
        const first = await bench(opts);
        await first.signIn("them");
        await send(first, "written by the previous account", {chat: "c-theirs", to: "their-peer"});
        await onDisk(first, ids(first));

        const b = await first.restart();                                         // their session ended without a sign-out
        expect(b.queue()).toEqual([]);                                           // not read before the owner is known
        await b.signIn(MY);                                                      // the owner check finds another account
        expect(b.queue()).toEqual([]);
        await onDisk(b, []);
        await connectAndFlush(b);
        await b.settle();
        expect(b.socket.sent("CHAT_IN")).toEqual([]);
    });

    it.each(DISKS)("3.2: the same without a restart — their 401, then my sign-in on the same page (%s)", async (_disk, opts) => {
        const b = await bench(opts);
        await b.signIn("them");
        await send(b, "written by the previous account", {chat: "c-theirs", to: "their-peer"});
        await onDisk(b, ids(b));
        await sessionExpires(b, "them");
        expect(b.queue()).toHaveLength(1);                                       // theirs, kept for their next sign-in

        await b.signIn(MY);
        expect(b.queue()).toEqual([]);
        await onDisk(b, []);
        await connectAndFlush(b);
        await b.settle(500);
        expect(b.socket.sent("CHAT_IN")).toEqual([]);
        await onDisk(b, []);
    });

    it.each(DISKS)("3.3: a sign-out erases the queue — in memory, on the disk, and for the next start (%s)", async (_disk, opts) => {
        const first = await bench(opts);
        await first.signIn(MY);
        await send(first, "never sent");
        await onDisk(first, ids(first));

        first.store.dispatch(first.m.logout.logoutResetClientState());
        expect(first.queue()).toEqual([]);
        await first.settle(500);
        await onDisk(first, []);

        const b = await first.restart();
        await b.signIn(MY);
        expect(b.queue()).toEqual([]);
        await connectAndFlush(b);
        expect(b.socket.sent("CHAT_IN")).toEqual([]);
    });

    // Was A4 of the audit: a queued message was matched to the server's rows by its text.
    it("3.4: a queued message whose text I have sent before stays on the screen when the history is read", async () => {
        const b = await bench();
        await b.signIn(MY);
        const chat = b.open(CHAT);
        await b.server.history(CHAT).answer([row({id: M1, chat: CHAT, from: MY, to: PEER, body: "ok"})]);   // yesterday's "ok"
        await chat.read;

        await send(b, "ok");                                                     // no connection: it waits
        const [queued] = ids(b);
        const again = chat.reread();
        await b.server.history(CHAT).answer([row({id: M1, chat: CHAT, from: MY, to: PEER, body: "ok"})]);
        await again;

        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1, queued]);
        expect(ids(b)).toEqual([queued]);                                        // marked "waiting" by the queue
    });

    it("3.4: a queued message that was never shown is put on the screen by the read, whatever its text", async () => {
        const b = await bench();
        await b.signIn(MY);
        const queued = b.m.mapper.toOutboxMessage({conversationId: CHAT, recipientId: PEER, text: "ok"});
        b.store.dispatch(b.m.outbox.enqueueMessage(queued));
        const chat = b.open(CHAT);
        await b.server.history(CHAT).answer([row({id: M1, chat: CHAT, from: MY, to: PEER, body: "ok"})]);
        await chat.read;
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1, queued.id]);
    });

    it("3.4: the server's row of a queued message (its confirmation was lost) is the same row, not a second one", async () => {
        const b = await bench();
        await b.signIn(MY);
        const chat = b.open(CHAT);
        await b.server.history(CHAT).answer([]);
        await chat.read;
        await send(b, "ok");
        const [queued] = ids(b);

        const again = chat.reread();
        await b.server.history(CHAT).answer([row({id: M1, chat: CHAT, from: MY, to: PEER, body: "ok", clientId: queued})]);
        await again;
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1]);
    });

    describe("3.5: a refusal before the queue leaves the text in the input field", () => {
        const TEXT = "what I typed";

        /** The input field of the open chat, as ChatWindow has it. */
        async function field(b: B, o: {to?: string; summary?: boolean} = {}) {
            const {useMessageComposer} = await import("@/features/chat/hooks/useMessageComposer");
            const getSummary = () => (o.summary === false ? null : {counterpartId: o.to ?? PEER});
            const view = renderHook(() => useMessageComposer({selectedChatId: CHAT, myId: MY, getSummary}), {wrapper: b.wrapper});
            act(() => { view.result.current.setMessageInput(TEXT); });
            return view;
        }
        /** The user presses "send" and the app has done what it does with it. */
        async function press(b: B, view: Awaited<ReturnType<typeof field>>) {
            await act(async () => {
                view.result.current.sendMessage(TEXT);
                await b.settle();
            });
        }
        const nothingLeft = (b: B) => {
            expect(b.queue()).toEqual([]);
            expect(b.socket.sent("CHAT_IN")).toEqual([]);
            expect(b.screen(CHAT) ?? []).toEqual([]);
        };

        it.each([
            ["the other side has no keys", "no_device"],
            ["the other side is not in the app", "no_passport"],
            ["the key directory cannot be reached", "no_network"],
            ["the key of a verified contact has changed", "reverify"],
            ["an error the library does not name", "boom"],
        ])("3.5: a secret chat, %s — the text stays, the reason is shown", async (_why, code) => {
            const b = await bench({app: true});
            await b.signIn(MY);
            b.socket.connect();
            b.store.dispatch(b.m.secret.markSecret(CHAT));
            b.app.refuseEncrypt(code);
            const view = await field(b);
            await press(b, view);

            expect(view.result.current.messageInput).toBe(TEXT);
            expect(b.m.drafts.loadDraft(CHAT)).toBe(TEXT);
            expect(b.errors()).toHaveLength(1);
            nothingLeft(b);

            // the reason is gone: the same text goes out, encrypted, and the field is empty
            b.app.refuseEncrypt(null);
            await press(b, view);
            expect(view.result.current.messageInput).toBe("");
            expect(b.m.drafts.loadDraft(CHAT)).toBe("");
            expect(b.socket.sent("CHAT_IN").map((f) => (f.payload as {body: string}).body)).toEqual([expect.stringMatching(/^E2EE2:/)]);
            expect(b.screen(CHAT)?.map((m) => m.text)).toEqual([TEXT]);
            view.unmount();
        });

        it("3.5: a secret chat in a browser — the text stays", async () => {
            const b = await bench();
            await b.signIn(MY);
            b.store.dispatch(b.m.secret.markSecret(CHAT));
            const view = await field(b);
            await press(b, view);
            expect(view.result.current.messageInput).toBe(TEXT);
            expect(b.errors()).toHaveLength(1);
            nothingLeft(b);
            view.unmount();
        });

        it("3.5: a secret chat with no known recipient — the text stays", async () => {
            const b = await bench({app: true});
            await b.signIn(MY);
            b.store.dispatch(b.m.secret.markSecret(CHAT));
            const view = await field(b, {to: ""});
            await press(b, view);
            expect(view.result.current.messageInput).toBe(TEXT);
            expect(b.errors()).toHaveLength(1);
            nothingLeft(b);
            view.unmount();
        });

        it("3.5: the lists are not read yet (the phone is locked) — the text stays", async () => {
            const first = await bench({app: true});
            await first.signIn(MY);
            first.store.dispatch(first.m.secret.markSecret("c-other"));          // a list is stored, sealed
            for (let i = 0; i < 200 && !(await first.m.db.kvGet(first.m.db.KV.secretChats)); i++) await first.settle(5);
            first.app.lock();
            const b = await first.restart();
            await b.signIn(MY, MY, {settled: false});
            expect(b.m.lists.listsReady()).toBe(false);
            const view = await field(b);
            await press(b, view);
            expect(view.result.current.messageInput).toBe(TEXT);
            expect(b.errors()).toHaveLength(1);
            nothingLeft(b);
            view.unmount();
        });

        it("3.5: the chat cannot be resolved — the text stays", async () => {
            const b = await bench();
            await b.signIn(MY);
            const view = await field(b, {summary: false});
            await press(b, view);
            expect(view.result.current.messageInput).toBe(TEXT);
            expect(b.errors()).toHaveLength(1);
            nothingLeft(b);
            view.unmount();
        });

        it("3.5: an ordinary chat — queued, the field and the draft are empty", async () => {
            const b = await bench();
            await b.signIn(MY);
            const view = await field(b);
            await press(b, view);
            expect(view.result.current.messageInput).toBe("");
            expect(b.m.drafts.loadDraft(CHAT)).toBe("");
            expect(texts(b)).toEqual([TEXT]);
            expect(b.errors()).toEqual([]);
            view.unmount();
        });

        it("3.5: what the user typed while the message was being encrypted is not wiped", async () => {
            const b = await bench({app: true});
            await b.signIn(MY);
            b.store.dispatch(b.m.secret.markSecret(CHAT));
            const view = await field(b);
            await act(async () => {
                view.result.current.sendMessage(TEXT);
                view.result.current.setMessageInput("the next one");            // before the encryption has ended
                await b.settle();
            });
            expect(texts(b)).toHaveLength(1);
            expect(view.result.current.messageInput).toBe("the next one");
            view.unmount();
        });

        it("3.5: a second press while the first is on its way does not send the text twice", async () => {
            const b = await bench({app: true});
            await b.signIn(MY);
            b.store.dispatch(b.m.secret.markSecret(CHAT));
            const view = await field(b);
            await act(async () => {
                view.result.current.sendMessage(TEXT);
                view.result.current.sendMessage(TEXT);
                await b.settle();
            });
            expect(b.queue()).toHaveLength(1);
            expect(view.result.current.messageInput).toBe("");
            view.unmount();
        });

        it("3.5: a forward into a secret chat that cannot be encrypted is not queued and not reported as done", async () => {
            const b = await bench({app: true});
            await b.signIn(MY);
            b.store.dispatch(b.m.secret.markSecret("c2"));
            b.app.refuseEncrypt("no_device");
            const toast = (await import("react-hot-toast")).default;
            const done = vi.spyOn(toast, "success").mockImplementation(() => "");
            const view = await field(b);
            await act(async () => {
                view.result.current.forwardMessage("c2", "forwarded text");
                await b.settle();
            });
            expect(b.queue()).toEqual([]);
            expect(b.errors()).toHaveLength(1);
            expect(done).not.toHaveBeenCalled();

            b.app.refuseEncrypt(null);
            await act(async () => {
                view.result.current.forwardMessage("c2", "forwarded text");
                await b.settle();
            });
            expect(b.queue()).toHaveLength(1);
            expect(done).toHaveBeenCalledTimes(1);
            view.unmount();
        });

        it("3.5: the line about an unanswered call in a secret chat that cannot be encrypted is not queued", async () => {
            const b = await bench({app: true});
            await b.signIn(MY);
            b.app.refuseEncrypt("no_network");
            expect(await send(b, "📞 unanswered call", {secret: true, meta: {call: "missed", media: "audio"}})).toBe(false);
            expect(b.queue()).toEqual([]);
            b.app.refuseEncrypt(null);
            expect(await send(b, "📞 unanswered call", {secret: true, meta: {call: "missed", media: "audio"}})).toBe(true);
            expect(b.queue().map((m) => m.payload.meta)).toEqual([{call: "missed", media: "audio"}]);
        });
    });

    describe("3.6: the queue goes to the disk at once when the app leaves the screen", () => {
        /** A message is queued, the app leaves the screen and is killed 50 ms later; what the next start finds. */
        async function killedAfter(opts: BenchOptions, leave: (b: B) => void): Promise<{queued: string[]; b: B}> {
            const first = await bench(opts);
            await first.signIn(MY);
            await send(first, "typed without a connection");
            const queued = ids(first);
            leave(first);
            await first.settle(50);                                              // the ordinary write waits 400 ms
            const b = await first.restart();
            await b.signIn(MY);
            return {queued, b};
        }

        it.each(DISKS)("3.6: the page is hidden (%s)", async (_disk, opts) => {
            const {queued, b} = await killedAfter(opts, (first) => first.page.hide());
            expect(ids(b)).toEqual(queued);
        });

        it.each(DISKS)("3.6: the page is closed (%s)", async (_disk, opts) => {
            const {queued, b} = await killedAfter(opts, (first) => first.page.leave());
            expect(ids(b)).toEqual(queued);
        });

        it("3.6: the Android app goes to the background", async () => {
            const {queued, b} = await killedAfter({app: true}, (first) => first.app.emit("appBackground"));
            expect(ids(b)).toEqual(queued);
        });

        it("3.6: killed without leaving the screen, inside the delay of the write — the message is not on the disk", async () => {
            const {b} = await killedAfter({}, () => {});
            expect(b.queue()).toEqual([]);                                       // the price of the delay; a kill gives no warning
        });
    });

    it.each(DISKS)("3.7: a message sent before the queue is read from the disk — the stored ones and the new one are both there (%s)", async (_disk, opts) => {
        const first = await bench(opts);
        await first.signIn(MY);
        await send(first, "stored one");
        await send(first, "stored two");
        const stored = ids(first);
        await onDisk(first, stored);

        const b = await first.restart();
        await b.signIn(MY, MY, {settled: false});
        expect(b.store.getState().outbox.restored).toBe(false);                  // the disk is still being read
        await send(b, "typed at once");
        const fresh = ids(b);
        expect(fresh).toHaveLength(1);

        await b.until(() => b.store.getState().outbox.restored, "the queue to be read");
        expect(ids(b)).toEqual([...stored, ...fresh]);
        await onDisk(b, [...stored, ...fresh]);                                  // and the disk was not replaced by the new one alone
    });

    it.each(DISKS)("3.8: the order of the queue is the same after a restart, and it is sent in that order (%s)", async (_disk, opts) => {
        const first = await bench(opts);
        await first.signIn(MY);
        for (const text of ["one", "two", "three", "four"]) {
            await send(first, text);
            await first.settle(5);
        }
        const queued = ids(first);
        await onDisk(first, queued);

        const b = await first.restart();
        await b.signIn(MY);
        expect(texts(b)).toEqual(["one", "two", "three", "four"]);
        await connectAndFlush(b);
        expect(sentIds(b)).toEqual(queued);
    });

    describe("edge cases of story 3", () => {
        const ack = (b: B, clientId: string, serverId: string) =>
            b.socket.frame({type: "CHAT_ACK", correlationId: clientId, conversationId: CHAT, serverMessageId: serverId, serverTimestamp: 1_700_000_000_000});

        it("a message the server never takes (its chat is gone there) ends as not sent and holds nothing up", async () => {
            const b = await bench();
            await b.signIn(MY);
            b.socket.connect();
            let now = Date.now();
            vi.spyOn(Date, "now").mockImplementation(() => now);
            await send(b, "into a chat the server has deleted", {chat: "c-gone"});
            now += 1_000;
            await send(b, "into a living chat");
            const [gone, alive] = ids(b);
            expect(sentIds(b)).toEqual([gone, alive]);
            ack(b, alive, M1);
            expect(ids(b)).toEqual([gone]);                                      // the one behind it went through

            for (let i = 0; i < 10 && b.queue()[0]?.status !== "failed"; i++) {
                now += 7_000;                                                    // longer than the wait for a confirmation
                await b.store.dispatch(b.m.flush.flushOutbox());
            }
            expect(b.queue().map((m) => m.status)).toEqual(["failed"]);
            const before = b.socket.sent("CHAT_IN").length;
            now += 7_000;
            await b.store.dispatch(b.m.flush.flushOutbox());
            expect(b.socket.sent("CHAT_IN")).toHaveLength(before);               // given up: not sent again by itself

            await send(b, "the next one");
            expect(sentIds(b).at(-1)).toBe(ids(b)[1]);
        });

        it("the server says the message is invalid — it is marked not sent at once", async () => {
            const b = await bench();
            await b.signIn(MY);
            b.socket.connect();
            await send(b, "refused by the server");
            const [refused] = ids(b);
            b.socket.frame({type: "SERVICE_OUT", correlationId: refused, payload: {kind: "event", body: "invalid"}});
            expect(b.queue().map((m) => m.status)).toEqual(["failed"]);
            b.socket.frame({type: "SERVICE_OUT", correlationId: refused, payload: {kind: "event", body: "overloaded"}});
            expect(b.queue()).toHaveLength(1);                                   // an overloaded server is not a refusal
        });

        it("the Vault is closed when the queue is written: the write waits, the queue in memory is whole, nothing typed later is lost", async () => {
            const first = await bench({app: true});
            await first.signIn(MY);
            await send(first, "before the lock");
            await onDisk(first, ids(first));

            first.app.lock();
            await send(first, "typed under a closed Vault");
            await first.settle(600);
            expect(texts(first)).toEqual(["before the lock", "typed under a closed Vault"]);
            first.app.unlock();
            await onDisk(first, ids(first));                                     // the write that waited has landed
            const queued = ids(first);

            const b = await first.restart();
            await b.signIn(MY);
            expect(ids(b)).toEqual(queued);
        });

        it("the phone is locked at the start: what is sent after the unlock joins the stored queue", async () => {
            const first = await bench({app: true});
            await first.signIn(MY);
            await send(first, "stored");
            const stored = ids(first);
            await onDisk(first, stored);
            first.app.lock();

            const b = await first.restart();
            await b.signIn(MY, MY, {settled: false});
            await b.settle(100);
            expect(b.queue()).toEqual([]);                                       // nothing can be read yet
            expect(await send(b, "typed under the lock")).toBe(false);           // the lists are sealed too: nothing is sent
            expect(b.errors()).toHaveLength(1);
            b.app.unlock();
            await b.until(() => b.store.getState().outbox.restored && b.m.lists.listsReady(), "the queue and the lists to be read");
            expect(ids(b)).toEqual(stored);
            await send(b, "typed after the unlock");
            expect(texts(b)).toEqual(["stored", "typed after the unlock"]);
            await onDisk(b, ids(b));

            const next = await b.restart();
            await next.signIn(MY);
            expect(texts(next)).toEqual(["stored", "typed after the unlock"]);
        });
    });
});
