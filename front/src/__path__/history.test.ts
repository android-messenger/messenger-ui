import {describe, it, expect, afterEach} from "vitest";
import {act, renderHook} from "@testing-library/react";
import {bench, stop, row} from "./bench";

// Spec 003, story 2 — what the chat has taken stays in it. The messages live in the chatHistory slice;
// the socket writes there whether the chat is on the screen or not, and an answer of the history is merged
// into the chat, never put instead of it.

const MY = "me";
const PEER = "peer";
const CHAT = "c1";
const M1 = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const M2 = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
const M3 = "01ARZ3NDEKTSV4RRFFQ69G5FA3";
const msg = (id: string, from: string, body: string) => row({id, chat: CHAT, from, to: from === MY ? PEER : MY, body});

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

        act(() => { b.socket.frame(msg(M3, PEER, "third")); });
        expect(view.result.current.messages.map((m) => m.id)).toEqual([M2, M1, M3]);

        act(() => { b.store.dispatch(b.m.chatUi.setSelectedChatId(null)); });
        await onDisk(b, [M2, M1, M3]);
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
