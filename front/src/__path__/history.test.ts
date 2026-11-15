import {describe, it, expect, afterEach} from "vitest";
import {act, renderHook} from "@testing-library/react";
import {useSelector} from "react-redux";
import {bench, stop, row, type BenchOptions} from "./bench";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema";

// Spec 003, story 2 — what the chat has taken stays in it. The messages live in the chatHistory slice;
// the socket writes there whether the chat is on the screen or not, and an answer of the history is merged
// into the chat, never put instead of it.

const MY = "me";
const PEER = "peer";
const CHAT = "c1";
const M1 = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const M2 = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
const M3 = "01ARZ3NDEKTSV4RRFFQ69G5FA3";
const T = 1_700_000_000_000;
const msg = (id: string, from: string, body: string, at?: number) => row({id, chat: CHAT, from, to: from === MY ? PEER : MY, body, at});
/** A row as the device's copy of the chat holds it. */
const stored = (id: string, from: string, text: string): ChatMessage =>
    ({id, chatId: CHAT, from, to: from === MY ? PEER : MY, text, createdAt: new Date(T), status: "sent"});
/** A server id made at the moment `ms`, as the server makes it when it takes a message in. */
function idAt(ms: number): string {
    let head = "";
    for (let i = 0; i < 10; i++) { head = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[ms % 32] + head; ms = Math.floor(ms / 32); }
    return head + "0000000000000000";
}
/** A server id: they order as their numbers do. */
const U = (n: number) => "01ARZ3NDEKTSV4RRFFQ6" + String(n).padStart(6, "0");
const page = (from: number, to: number) => Array.from({length: to - from + 1}, (_, i) => msg(U(from + i), PEER, `m${from + i}`, T + from + i));
/** The two kinds of disk: a browser keeps the records open, the Android app seals them with the Vault. */
const DISKS: Array<[string, BenchOptions]> = [["browser", {}], ["app", {app: true}]];

type B = Awaited<ReturnType<typeof bench>>;
/** Waits until the device's copy of the chat holds exactly these messages (a write is never awaited by the app). */
async function onDisk(b: B, ids: string[]): Promise<void> {
    let found: string[] | undefined;
    for (let i = 0; i < 200; i++) {
        found = (await b.m.db.loadHistoryFromDB(CHAT))?.map((m) => m.id);
        if (JSON.stringify(found) === JSON.stringify(ids)) return;
        await b.settle(5);
    }
    expect(found).toEqual(ids);
}

/** A signed-in user with the socket connected and the chat read: M1 on the screen. */
async function opened() {
    const b = await bench();
    await b.signIn(MY);
    b.socket.connect();
    const chat = b.open(CHAT);
    await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);
    await chat.read;
    return {b, chat};
}

describe("story 2: what the chat has taken stays", () => {
    afterEach(stop);

    // Was A1 of the audit: the answer wiped the message and the chat counted as complete.
    it("2.1: a message that comes over the socket while the history is read again stays after the answer", async () => {
        const {b, chat} = await opened();
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1]);

        // The chat is read again (return to the screen, an attachment was sent, "retry"). The server reads its
        // table, and only then stores and delivers the next message: the answer on its way does not hold it.
        const reread = chat.reread();
        b.socket.frame(msg(M2, PEER, "second"));
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1, M2]);
        expect(b.socket.sent("CHAT_ACK")).toHaveLength(1);                       // the server will not send it again

        await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);
        await reread;
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1, M2]);              // still there
        expect(b.stale(CHAT)).toBe(false);                                       // and the chat IS complete
        await b.settle();
        expect(b.server.history(CHAT).asked()).toBe(2);
    });

    it("2.1: a message the server deleted before the chat was read again does not stay", async () => {
        const {b, chat} = await opened();
        b.socket.frame(msg(M2, PEER, "second"));                                 // came before the request
        const reread = chat.reread();
        await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);           // the server no longer has it
        await reread;
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1]);
    });

    // Was A2 of the audit: acknowledged and never shown.
    it("2.2: a message that comes over the socket while the chat is read for the first time is shown and stays", async () => {
        const b = await bench();
        await b.signIn(MY);
        b.socket.connect();
        const chat = b.open(CHAT);
        b.socket.frame(msg(M2, PEER, "second"));
        expect(b.socket.sent("CHAT_ACK")).toHaveLength(1);
        await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);
        await chat.read;
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1, M2]);
        expect(b.stale(CHAT)).toBe(false);
    });

    it("2.2: a chat that left the screen still takes what the socket brings, and is not read again when opened", async () => {
        const {b, chat} = await opened();
        await chat.close();
        b.socket.frame(msg(M2, PEER, "second"));
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1, M2]);
        await b.open(CHAT).read;
        expect(b.server.history(CHAT).asked()).toBe(1);                          // complete under this connection
    });

    it("2.2: a message for a chat that was never opened is acknowledged and read from the server when the chat is opened", async () => {
        const b = await bench();
        await b.signIn(MY);
        b.socket.connect();
        b.socket.frame(msg(M1, PEER, "first"));
        expect(b.socket.sent("CHAT_ACK")).toHaveLength(1);
        expect(b.screen(CHAT)).toBeUndefined();
        const chat = b.open(CHAT);
        await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);
        await chat.read;
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1]);
    });
});

describe("reading the history (readHistory)", () => {
    afterEach(stop);

    it("two reads of a chat at once are one request, and neither empties the chat", async () => {
        const {b, chat} = await opened();
        const first = chat.reread();
        const second = chat.reread();
        await b.until(() => b.server.history(CHAT).waiting() === 1, "the request");
        await b.server.history(CHAT).answer([msg(M1, PEER, "first"), msg(M2, PEER, "second")]);
        expect(await first).toBe(true);
        expect(await second).toBe(true);
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1, M2]);
        await b.settle();
        expect(b.server.history(CHAT).asked()).toBe(2);
    });

    it("a read that started while the socket was down proves nothing: the chat is read once more under the connection", async () => {
        const b = await bench();
        await b.signIn(MY);
        const chat = b.open(CHAT);                                               // no socket yet
        await b.until(() => b.server.history(CHAT).waiting() === 1, "the request");
        b.socket.connect();
        await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);
        await chat.read;
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1]);
        expect(b.stale(CHAT)).toBe(true);

        await b.server.history(CHAT).answer([msg(M1, PEER, "first"), msg(M2, PEER, "second")]);
        await b.until(() => !b.stale(CHAT), "the chat to be complete");
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1, M2]);
        await b.settle();
        expect(b.server.history(CHAT).asked()).toBe(2);
    });

    it("a read with the socket down shows the answer and asks nothing more", async () => {
        const b = await bench();
        await b.signIn(MY);
        const chat = b.open(CHAT);
        await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);
        await chat.read;
        await b.settle();
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1]);
        expect(b.stale(CHAT)).toBe(true);
        expect(b.server.history(CHAT).asked()).toBe(1);
    });

    it("a failed read keeps the rows and says so; the next good read takes the mark off", async () => {
        const {b, chat} = await opened();
        const failed = chat.reread();
        await b.server.history(CHAT).fail();
        expect(await failed).toBe(false);
        expect(b.readFailed(CHAT)).toBe(true);
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1]);

        const again = chat.reread();
        await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);
        await again;
        expect(b.readFailed(CHAT)).toBe(false);
    });

    it("a 404 is an empty chat, not an error", async () => {
        const b = await bench();
        await b.signIn(MY);
        const chat = b.open(CHAT);
        await b.server.history(CHAT).status(404);
        await chat.read;
        expect(b.screen(CHAT)).toEqual([]);
        expect(b.readFailed(CHAT)).toBe(false);
    });

    it("the answer brings the peer's read position", async () => {
        const b = await bench();
        await b.signIn(MY);
        const chat = b.open(CHAT);
        await b.server.history(CHAT).answer([msg(M1, MY, "mine")], {peerLastReadId: M1});
        await chat.read;
        expect(b.store.getState().chatUi.peerLastReadIdByChat[CHAT]).toBe(M1);
    });

    it("my queued message stays on the screen through a read of the history", async () => {
        const {b, chat} = await opened();
        await b.m.service.chatMessagesService.enqueueChatMessage(b.store.dispatch, "hello", MY, CHAT, PEER);
        const queued = b.queue()[0].id;
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1, queued]);
        const reread = chat.reread();
        await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);
        await reread;
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1, queued]);
    });

    it("the server confirms my message while the history is read: one row, under the server's id", async () => {
        const {b, chat} = await opened();
        await b.m.service.chatMessagesService.enqueueChatMessage(b.store.dispatch, "hello", MY, CHAT, PEER);
        const queued = b.queue()[0].id;
        const reread = chat.reread();                                            // the server reads its table…
        b.socket.frame({type: "CHAT_ACK", conversationId: CHAT, correlationId: queued, serverMessageId: M2, serverTimestamp: 1_700_000_000_500});
        expect(b.queue()).toHaveLength(0);
        await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);           // …before it stored my message
        await reread;
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1, M2]);

        const later = chat.reread();
        await b.server.history(CHAT).answer([msg(M1, PEER, "first"), row({id: M2, chat: CHAT, from: MY, to: PEER, body: "hello", clientId: queued})]);
        await later;
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1, M2]);
    });

    it("the rows go to the disk after an answer and when the chat leaves the screen", async () => {
        const {b, chat} = await opened();
        await onDisk(b, [M1]);
        b.socket.frame(msg(M2, PEER, "second"));
        await chat.close();
        await onDisk(b, [M1, M2]);
    });

    it("sign-out leaves nothing of the chats in memory", async () => {
        const {b} = await opened();
        b.store.dispatch(b.m.logout.logoutResetClientState());
        expect(b.screen(CHAT)).toBeUndefined();
        expect(b.store.getState().chatHistory.byChat).toEqual({});
    });

    it("another account signing in on this device finds nothing of the chats in memory", async () => {
        const {b} = await opened();
        b.server.expireSession();                                                // their session ended without a sign-out
        await b.store.dispatch(b.m.api.chatApi.endpoints.getChats.initiate({myId: MY}, {subscribe: false}));
        await b.until(() => b.store.getState().user.id !== MY, "the user to be cleared");
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1]);                  // the same user may come back
        await b.signIn("other");
        expect(b.screen(CHAT)).toBeUndefined();
    });
});

describe("the other writers of a chat", () => {
    afterEach(stop);

    it("deleting a message takes its row out at once and off the disk; a refusal puts it back", async () => {
        const {b} = await opened();
        b.socket.frame(msg(M2, PEER, "second"));
        b.socket.frame(msg(M3, PEER, "third"));
        const del = b.m.api.chatApi.endpoints.deleteMessage;

        const ok = b.store.dispatch(del.initiate({chatId: CHAT, backendId: M2}));
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1, M3]);
        await ok;
        await onDisk(b, [M1, M3]);

        b.server.reply("DELETE", /^\/chats\/c1\/messages/, () => new Response("{}", {status: 409, headers: {"Content-Type": "application/json"}}));
        const refused = b.store.dispatch(del.initiate({chatId: CHAT, backendId: M1}));
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M3]);
        await refused;
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1, M3]);              // back in its place
    });

    it("deleting my message that has only its client id yet", async () => {
        const {b} = await opened();
        await b.m.service.chatMessagesService.enqueueChatMessage(b.store.dispatch, "hello", MY, CHAT, PEER);
        const queued = b.queue()[0].id;
        await b.store.dispatch(b.m.api.chatApi.endpoints.deleteMessage.initiate({chatId: CHAT, clientMessageId: queued}));
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1]);
    });

    it("clearing the chat empties it", async () => {
        const {b} = await opened();
        const deleteHistory = ((arg: {myId: string; chatId: string}) => b.store.dispatch(b.m.api.chatApi.endpoints.deleteChatHistory.initiate(arg))) as never;
        await b.m.service.chatMessagesService.clearChatHistory(b.store.dispatch, deleteHistory, MY, CHAT);
        expect(b.screen(CHAT)).toEqual([]);
    });

    it("an older page goes before the rows", async () => {
        const {b} = await opened();
        const OLD = "01ARZ3NDEKTSV4RRFFQ69G5F00";
        b.server.reply("GET", /^\/chats\/c1\/messages\?.*before=/, () => ({messages: [msg(OLD, PEER, "older")]}));
        expect(await b.store.dispatch(b.m.older.loadOlderHistory(CHAT))).toBe(1);
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([OLD, M1]);
        expect(b.server.requests().at(-1)?.path).toContain(`before=${M1}`);
    });
});

describe("the chat on the screen (useChatMessages)", () => {
    afterEach(stop);

    it("opening a chat reads it: the loader, then the messages; leaving it writes the disk", async () => {
        const b = await bench();
        await b.signIn(MY);
        b.socket.connect();
        const {useChatMessages} = await import("@/features/chat/hooks/useChatMessages");
        const view = renderHook(() => useChatMessages(), {wrapper: b.wrapper});
        expect(view.result.current).toMatchObject({messages: [], loadingHistory: false, isError: false});

        act(() => { b.store.dispatch(b.m.chatUi.setSelectedChatId(CHAT)); });
        expect(view.result.current.loadingHistory).toBe(true);
        await act(async () => {
            await b.server.history(CHAT).answer([msg(M2, PEER, "second"), msg(M1, MY, "first")]);
            await b.until(() => !!b.screen(CHAT), "the rows");
        });
        expect(view.result.current.loadingHistory).toBe(false);
        expect(view.result.current.messages.map((m) => [m.id, m.fromMe])).toEqual([[M2, false], [M1, true]]);

        const NEW = idAt(T + 1);                                                 // taken by the server after the two
        act(() => { b.socket.frame(msg(NEW, PEER, "third")); });
        expect(view.result.current.messages.map((m) => m.id)).toEqual([M2, M1, NEW]);

        act(() => { b.store.dispatch(b.m.chatUi.setSelectedChatId(null)); });
        await onDisk(b, [M2, M1, NEW]);
        expect(view.result.current.messages).toEqual([]);
        view.unmount();
    });

    it("a failed first read is an error on the screen, not an empty chat; retry reads again", async () => {
        const b = await bench();
        await b.signIn(MY);
        const {useChatMessages} = await import("@/features/chat/hooks/useChatMessages");
        const view = renderHook(() => useChatMessages(), {wrapper: b.wrapper});
        act(() => { b.store.dispatch(b.m.chatUi.setSelectedChatId(CHAT)); });
        await act(async () => {
            await b.server.history(CHAT).fail();
            await b.until(() => b.readFailed(CHAT), "the failure");
        });
        expect(view.result.current).toMatchObject({messages: [], loadingHistory: false, isError: true});

        await act(async () => {
            const retry = view.result.current.reloadChatHistory();
            await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);
            await retry;
        });
        expect(view.result.current.isError).toBe(false);
        expect(view.result.current.messages.map((m) => m.id)).toEqual([M1]);
        view.unmount();
    });

    it("a chat that already has its rows is shown at once and not read again", async () => {
        const {b, chat} = await opened();
        await chat.close();
        const {useChatMessages} = await import("@/features/chat/hooks/useChatMessages");
        const view = renderHook(() => useChatMessages(), {wrapper: b.wrapper});
        act(() => { b.store.dispatch(b.m.chatUi.setSelectedChatId(CHAT)); });
        expect(view.result.current).toMatchObject({loadingHistory: false, isError: false});
        expect(view.result.current.messages.map((m) => m.id)).toEqual([M1]);
        await b.settle();
        expect(b.server.history(CHAT).asked()).toBe(1);
        view.unmount();
    });
});

// Story 2б — the device's copy, my own message, the older pages.

/** A signed-in user on a device that holds the chat on its disk. */
async function device(opts: BenchOptions, rows: ChatMessage[]) {
    const b = await bench(opts);
    await b.signIn(MY);
    await b.m.db.saveHistoryToDB(CHAT, rows);
    return b;
}
const ids = (b: B) => b.screen(CHAT)?.map((m) => m.id);
/** The order on the screen: by time, as useChatMessages puts it. */
const shown = (b: B) => [...(b.screen(CHAT) ?? [])].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).map((m) => m.id);

describe("story 2: the device's copy of the chat", () => {
    afterEach(stop);

    for (const [disk, opts] of DISKS) {
        // Was A6 of the audit: the copy was read and dropped.
        it(`2.3: the history stored on the device is shown before the server answers and stays when the read fails (${disk})`, async () => {
            const b = await device(opts, [stored(M1, PEER, "first"), stored(M2, MY, "second")]);
            const chat = b.open(CHAT);
            await b.until(() => !!b.screen(CHAT), "the rows from the disk");
            expect(ids(b)).toEqual([M1, M2]);
            expect(b.screen(CHAT)!.every((m) => m.createdAt instanceof Date)).toBe(true);
            await b.until(() => b.server.history(CHAT).waiting() === 1, "the request");   // the server has not answered

            await b.server.history(CHAT).fail();
            await chat.read;
            expect(ids(b)).toEqual([M1, M2]);                                    // offline the chat is not empty
            expect(b.readFailed(CHAT)).toBe(true);                               // and the screen says it is not fresh

            const again = chat.reread();
            await b.server.history(CHAT).answer([msg(M1, PEER, "first"), msg(M2, MY, "second"), msg(M3, PEER, "third")]);
            await again;
            expect(ids(b)).toEqual([M1, M2, M3]);
            expect(b.readFailed(CHAT)).toBe(false);
            await onDisk(b, [M1, M2, M3]);
        });

        it(`2.8: the text of a secret message stays in memory through a read of the history and never goes to the disk (${disk})`, async () => {
            const b = await bench(opts);
            await b.signIn(MY);
            b.socket.connect();
            const chat = b.open(CHAT);
            await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);
            await chat.read;
            b.socket.frame(msg(M2, PEER, "second"));
            // the bench does not play decryption: the row gets its text the way the decryption gives it
            b.store.dispatch(b.m.history.rowFixed({chatId: CHAT, id: M2, fix: {text: "the secret text", secret: true}}));

            const reread = chat.reread();
            await b.server.history(CHAT).answer([msg(M1, PEER, "first"), msg(M2, PEER, "second")]);
            await reread;
            expect(b.screen(CHAT)?.map((m) => m.text)).toEqual(["first", "the secret text"]);
            await chat.close();
            await onDisk(b, [M1]);

            const next = await b.restart();                                      // the device's copy has no secret row
            await next.signIn(MY);
            const opened = next.open(CHAT);
            await next.until(() => !!next.screen(CHAT), "the rows from the disk");
            expect(next.screen(CHAT)?.map((m) => m.id)).toEqual([M1]);
            await next.server.history(CHAT).fail();
            await opened.read;
        });
    }

    it("2.3: a chat shown from the disk is read from the server when it is opened again", async () => {
        const b = await device({}, [stored(M1, PEER, "first")]);
        const chat = b.open(CHAT);
        await b.server.history(CHAT).fail();
        await chat.read;
        await chat.close();
        const again = b.open(CHAT);
        await b.server.history(CHAT).answer([msg(M1, PEER, "first"), msg(M2, PEER, "second")]);
        await again.read;
        expect(ids(b)).toEqual([M1, M2]);
        expect(b.server.history(CHAT).asked()).toBe(2);
    });

    it("2.3: a message that comes over the socket before the disk is read is not lost under the device's copy", async () => {
        const b = await device({}, [stored(M1, PEER, "first")]);
        b.socket.connect();
        const chat = b.open(CHAT);
        await b.m.service.chatMessagesService.enqueueChatMessage(b.store.dispatch, "hello", MY, CHAT, PEER);
        const queued = b.queue()[0].id;
        await b.until(() => (b.screen(CHAT)?.length ?? 0) === 2, "the rows from the disk");
        expect(ids(b)).toEqual([M1, queued]);
        await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);
        await chat.read;
        expect(ids(b)).toEqual([M1, queued]);
    });

    it("2.3: with the Vault closed nothing is shown from the disk, and the record is not written over by a chat that was not read (app)", async () => {
        const b = await device({app: true}, [stored(M1, PEER, "first"), stored(M2, PEER, "second")]);
        b.app.lock();
        const chat = b.open(CHAT);
        await b.server.history(CHAT).fail();
        await chat.read;
        expect(b.screen(CHAT)).toBeUndefined();                                  // the record could not be opened
        await b.m.service.chatMessagesService.enqueueChatMessage(b.store.dispatch, "hello", MY, CHAT, PEER);
        expect(b.screen(CHAT)).toHaveLength(1);

        b.app.unlock();
        await chat.close();                                                      // the chat holds one row of mine: not the chat
        await b.settle();
        expect((await b.m.db.loadHistoryFromDB(CHAT))?.map((m) => m.id)).toEqual([M1, M2]);
    });

    it("2.7: a message deleted on the server does not come back from the device's copy", async () => {
        const b = await device({}, [stored(M1, PEER, "first"), stored(M2, PEER, "second")]);
        const chat = b.open(CHAT);
        await b.until(() => !!b.screen(CHAT), "the rows from the disk");
        await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);
        await chat.read;
        expect(ids(b)).toEqual([M1]);
        await onDisk(b, [M1]);
    });

    it("2.7: a chat cleared on the server is empty after a read, whatever older pages were loaded", async () => {
        const {b, chat} = await opened();
        b.store.dispatch(b.m.history.olderTaken({chatId: CHAT, rows: [stored(U(1), PEER, "older")], noOlder: false}));
        expect(ids(b)).toEqual([U(1), M1]);
        const reread = chat.reread();
        await b.server.history(CHAT).answer([]);
        await reread;
        expect(ids(b)).toEqual([]);
    });
});

describe("story 2: my own message", () => {
    afterEach(stop);

    // Was A5 of the audit: queued and not shown.
    it("2.4: in a chat whose history could not be read, my new message is shown, and stays when the chat is read", async () => {
        const b = await bench();
        await b.signIn(MY);
        const chat = b.open(CHAT);
        await b.server.history(CHAT).fail();
        await chat.read;
        await b.m.service.chatMessagesService.enqueueChatMessage(b.store.dispatch, "hello", MY, CHAT, PEER);
        const queued = b.queue()[0].id;
        expect(ids(b)).toEqual([queued]);                                        // the bubble with the clock

        const again = chat.reread();
        await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);
        await again;
        expect(ids(b)).toEqual([M1, queued]);
    });

    it("2.4: my message to a chat that was never opened is there when the chat is opened, and the chat is read", async () => {
        const b = await bench();
        await b.signIn(MY);
        await b.m.service.chatMessagesService.enqueueChatMessage(b.store.dispatch, "hello", MY, CHAT, PEER);
        const queued = b.queue()[0].id;
        expect(ids(b)).toEqual([queued]);
        const chat = b.open(CHAT);
        await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);
        await chat.read;
        expect(ids(b)).toEqual([M1, queued]);
        expect(b.server.history(CHAT).asked()).toBe(1);
    });
});

describe("story 2: the older pages and the order", () => {
    afterEach(stop);

    /** The chat on the screen through useWindowedHistory, as ChatWindow uses it. */
    async function windowed(b: B) {
        const {useWindowedHistory} = await import("@/features/chat/hooks/useWindowedHistory");
        const list = {current: null};
        const none: ChatMessage[] = [];
        return renderHook(({chatId}: {chatId: string | null}) => {
            const rows = useSelector((s: ReturnType<B["store"]["getState"]>) => b.m.history.selectRows(s, chatId)) ?? none;
            return useWindowedHistory(rows, chatId, list);
        }, {wrapper: b.wrapper, initialProps: {chatId: CHAT as string | null}});
    }
    /** "Show earlier" until everything in memory is on the screen. */
    async function revealAll(b: B, view: Awaited<ReturnType<typeof windowed>>) {
        while (view.result.current.shown.length < (b.screen(CHAT)?.length ?? 0)) await act(() => view.result.current.showEarlier());
    }

    it("2.5: the older pages and 'show earlier' live through a read of the history", async () => {
        const b = await bench();
        await b.signIn(MY);
        b.socket.connect();
        const chat = b.open(CHAT);
        await b.server.history(CHAT).answer(page(1000, 1199));                   // a full page: there may be more
        await chat.read;
        const view = await windowed(b);
        await revealAll(b, view);
        expect(view.result.current.hasEarlier).toBe(true);

        // the server cannot be reached: nothing is added, and "show earlier" is still offered
        b.server.reply("GET", /^\/chats\/c1\/messages\?.*before=/, () => new Response("{}", {status: 503}));
        await act(() => view.result.current.showEarlier());
        expect(b.screen(CHAT)).toHaveLength(200);
        expect(view.result.current.hasEarlier).toBe(true);

        b.server.reply("GET", /^\/chats\/c1\/messages\?.*before=/, () => ({messages: page(950, 999)}));
        await act(() => view.result.current.showEarlier());                      // the last page: fewer rows than a full one
        expect(view.result.current.shown).toHaveLength(250);
        expect(view.result.current.hasEarlier).toBe(false);

        const reread = chat.reread();
        await b.server.history(CHAT).answer(page(1000, 1199));
        await act(async () => { await reread; });
        expect(ids(b)).toEqual(page(950, 1199).map((m) => m.messageId));         // the older page is still there
        expect(view.result.current.shown).toHaveLength(250);
        expect(view.result.current.hasEarlier).toBe(false);                      // and nothing older is offered

        // the chat leaves the screen and comes back: the window starts at the tail, the start is still known
        view.rerender({chatId: null});
        view.rerender({chatId: CHAT});
        expect(view.result.current.shown).toHaveLength(60);
        await revealAll(b, view);
        expect(view.result.current.hasEarlier).toBe(false);
        expect(b.server.requests().filter((r) => r.path.includes("before=")).length).toBe(2);
        view.unmount();
    });

    it("2.5: a chat whose whole history fits one page offers nothing earlier; a page with no rows ends the search", async () => {
        const {b} = await opened();
        const view = await windowed(b);
        expect(view.result.current.hasEarlier).toBe(false);
        view.unmount();

        const other = await bench();
        await other.signIn(MY);
        const chat = other.open(CHAT);
        await other.server.history(CHAT).answer(page(1000, 1199));
        await chat.read;
        other.server.reply("GET", /^\/chats\/c1\/messages\?.*before=/, () => ({messages: []}));
        expect(await other.store.dispatch(other.m.older.loadOlderHistory(CHAT))).toBe(0);
        expect(other.m.history.selectChatHistory(other.store.getState(), CHAT)?.noOlder).toBe(true);
    });

    // Finding 20 of the audit. The time in a frame is the time of the delivery — the server writes it anew at
    // every attempt; the time in the history is the time the server took the message in, the one in its id.
    it("2.6: the order on the screen does not change when the history is read again: a message's time is the time the server took it", async () => {
        const {b, chat} = await opened();
        const A = idAt(T + 1000), B = idAt(T + 2000), MINE = idAt(T + 3000);
        b.socket.frame(msg(B, PEER, "b", T + 2100));
        b.socket.frame(msg(A, PEER, "a", T + 9000));                             // taken first, delivered at the second attempt
        await b.m.service.chatMessagesService.enqueueChatMessage(b.store.dispatch, "hello", MY, CHAT, PEER);
        const queued = b.queue()[0].id;
        b.socket.frame({type: "CHAT_ACK", conversationId: CHAT, correlationId: queued, serverMessageId: MINE, serverTimestamp: T + 3050});
        expect(shown(b)).toEqual([M1, A, B, MINE]);

        const reread = chat.reread();
        await b.server.history(CHAT).answer([
            msg(M1, PEER, "first"), msg(A, PEER, "a", T + 1000), msg(B, PEER, "b", T + 2000),
            row({id: MINE, chat: CHAT, from: MY, to: PEER, body: "hello", clientId: queued, at: T + 3000}),
        ]);
        await reread;
        expect(shown(b)).toEqual([M1, A, B, MINE]);
        expect(ids(b)).toEqual([M1, A, B, MINE]);
        expect(b.screen(CHAT)?.slice(1).map((m) => m.createdAt.getTime())).toEqual([T + 1000, T + 2000, T + 3000]);
    });
});

// T320 — the edges of story 2.
describe("story 2: the edges", () => {
    afterEach(stop);

    it("the socket changes twice while the history is read: the chat is read once more, under the last connection", async () => {
        const {b, chat} = await opened();                                        // read under connection 1
        const reread = chat.reread();
        await b.until(() => b.server.history(CHAT).waiting() === 1, "the request");
        b.socket.drop();
        b.socket.connect();
        b.socket.drop();
        const last = b.socket.connect();
        b.socket.frame(msg(M2, PEER, "second"));                                 // came under the last connection
        await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);           // the answer proves nothing
        await reread;
        expect(ids(b)).toEqual([M1, M2]);
        expect(b.stale(CHAT)).toBe(true);

        await b.server.history(CHAT).answer([msg(M1, PEER, "first"), msg(M2, PEER, "second")]);
        await b.until(() => !b.stale(CHAT), "the chat to be complete");
        expect(b.m.history.selectChatHistory(b.store.getState(), CHAT)?.readEpoch).toBe(last);
        expect(ids(b)).toEqual([M1, M2]);
        await b.settle();
        expect(b.server.history(CHAT).asked()).toBe(3);                          // the first, the one in question, one more
    });

    it("the answer comes after the chat has left the screen: the chat takes it, the disk gets it, opening asks nothing", async () => {
        const b = await bench();
        await b.signIn(MY);
        b.socket.connect();
        const chat = b.open(CHAT);
        await b.until(() => b.server.history(CHAT).waiting() === 1, "the request");
        await chat.close();
        expect(await b.m.db.loadHistoryFromDB(CHAT)).toBeNull();                 // nothing to write yet
        b.socket.frame(msg(M2, PEER, "second"));
        await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);
        await chat.read;
        expect(ids(b)).toEqual([M1, M2]);
        await onDisk(b, [M1, M2]);

        await b.open(CHAT).read;
        expect(b.server.history(CHAT).asked()).toBe(1);
    });

    it("a message for a chat that is neither in memory nor on the disk: acknowledged, marked unread, read from the server when opened", async () => {
        const first = await bench();
        await first.signIn(MY);
        const b = await first.restart();
        await b.signIn(MY);
        b.socket.connect();
        b.socket.frame(msg(M1, PEER, "first"));
        expect(b.socket.sent("CHAT_ACK")).toHaveLength(1);
        expect(b.screen(CHAT)).toBeUndefined();
        expect(b.store.getState().chatUi.unreadByChat[CHAT]).toBe(true);
        expect(await b.m.db.loadHistoryFromDB(CHAT)).toBeNull();

        const chat = b.open(CHAT);
        await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);
        await chat.read;
        expect(ids(b)).toEqual([M1]);
        expect(b.stale(CHAT)).toBe(false);
    });
});
