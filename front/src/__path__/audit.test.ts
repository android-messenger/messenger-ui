import {describe, it, expect, afterEach} from "vitest";
import {bench, stop, row} from "./bench";

// Audit 2026-11-14 (specs/002-reliable-delivery/audit.md), findings A1–A7, on the bench of spec 003.
// Every test here states the behaviour AS IT IS NOW — a defect. The pull request that fixes a defect turns
// its test over and gives it the number of its scenario (specs/003-message-path/test-matrix.md).

const MY = "me";
const PEER = "peer";
const CHAT = "c1";
const M1 = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const M2 = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
const msg = (id: string, from: string, body: string) => row({id, chat: CHAT, from, to: from === MY ? PEER : MY, body});

describe("1.2: the audit findings A1–A7 run on the bench", () => {
    afterEach(stop);

    it("A1: a message that comes over the socket while the history is read again is acknowledged, then wiped by the answer — and the chat counts as complete", async () => {
        const b = await bench();
        await b.signIn(MY);
        b.socket.connect();
        const chat = b.open(CHAT);
        await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);
        await chat.read;
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1]);

        // The chat is read again (return to the screen, an attachment was sent, "retry"). The server reads its
        // table, and only then stores and delivers the next message: the answer on its way does not hold it.
        const reread = chat.reread();
        b.socket.frame(msg(M2, PEER, "second"));
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1, M2]);              // shown for a moment
        expect(b.socket.sent("CHAT_ACK")).toHaveLength(1);                       // the server will not send it again

        await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);
        await reread;
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1]);                  // DEFECT: the message is gone from the screen
        expect(b.stale(CHAT)).toBe(false);                                       // DEFECT: nothing will read the chat again
        await b.settle();
        expect(b.server.history(CHAT).asked()).toBe(2);
    });

    it("A2: the same while the chat is read for the first time — the message is acknowledged and never shown", async () => {
        const b = await bench();
        await b.signIn(MY);
        b.socket.connect();
        const chat = b.open(CHAT);
        b.socket.frame(msg(M2, PEER, "second"));
        expect(b.socket.sent("CHAT_ACK")).toHaveLength(1);
        await b.server.history(CHAT).answer([msg(M1, PEER, "first")]);
        await chat.read;
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1]);                  // DEFECT
        expect(b.stale(CHAT)).toBe(false);                                       // DEFECT
    });

    it("A3: a 401 on any request empties the send queue — the unsent messages are gone", async () => {
        const b = await bench();
        await b.signIn(MY);
        b.store.dispatch(b.m.outbox.enqueueMessage(b.m.mapper.toOutboxMessage({conversationId: CHAT, recipientId: PEER, text: "not sent yet"})));
        expect(b.queue()).toHaveLength(1);
        b.server.expireSession();
        await b.store.dispatch(b.m.api.chatApi.endpoints.getChats.initiate({myId: MY}, {subscribe: false}));
        await b.settle();
        expect(b.queue()).toHaveLength(0);                                       // DEFECT: the same user signs in again to an empty queue
    });

    it("A4: a queued message whose text I have sent before disappears from the chat when the history is read", async () => {
        const b = await bench();
        await b.signIn(MY);
        b.socket.connect();
        const queued = b.m.mapper.toOutboxMessage({conversationId: CHAT, recipientId: PEER, text: "ok"});
        b.store.dispatch(b.m.outbox.enqueueMessage(queued));
        const chat = b.open(CHAT);
        await b.server.history(CHAT).answer([msg(M1, MY, "ok")]);                // yesterday's "ok", delivered long ago
        await chat.read;
        expect(b.queue().map((m) => m.id)).toEqual([queued.id]);                 // still to be sent
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([M1]);                  // DEFECT: and not on the screen
    });

    it("A5: in a chat whose history could not be read, my new message is queued but not shown", async () => {
        const b = await bench();
        await b.signIn(MY);
        const chat = b.open(CHAT);
        await b.server.history(CHAT).fail();
        await chat.read;
        expect(b.readFailed(CHAT)).toBe(true);
        await b.m.service.chatMessagesService.enqueueChatMessage(b.store.dispatch, "hello", MY, CHAT, PEER);
        expect(b.queue()).toHaveLength(1);
        expect(b.screen(CHAT)).toBeUndefined();                                  // DEFECT: no bubble with the clock
    });

    it("A6: the history stored on the device is not shown while the first read is on its way, nor after it failed", async () => {
        const b = await bench();
        await b.m.db.saveHistoryToDB(CHAT, [{id: M1, chatId: CHAT, from: PEER, to: MY, text: "cached", createdAt: new Date(), status: "sent"}]);
        await b.signIn(MY);
        const chat = b.open(CHAT);
        await b.settle();
        expect(b.screen(CHAT)).toBeUndefined();                                  // DEFECT: the cache was read and dropped
        await b.server.history(CHAT).fail();
        await chat.read;
        await b.settle();
        expect(b.screen(CHAT)).toBeUndefined();                                  // DEFECT: offline the chat is empty
    });

    // Finding 9. The send queue is read from disk at the start, before anyone knows whose session this is.
    // When the owner check then finds another account, the disk is erased — the queue in memory is not, and
    // it is sent under the new account as soon as the socket connects.
    it("A7: the queue of the previous account stays in memory after the cache of another account was dropped", async () => {
        const first = await bench();
        await first.signIn("them");
        const theirs = first.m.mapper.toOutboxMessage({conversationId: "c-theirs", recipientId: "their-peer", text: "written by the previous account"});
        first.store.dispatch(first.m.outbox.enqueueMessage(theirs));
        await first.until(() => first.store.getState().outbox.persistedVersion === first.store.getState().outbox.outboxVersion, "the queue on disk");

        const b = await first.restart();                                         // their session ended without a sign-out
        expect(b.queue()).toHaveLength(1);
        await b.signIn(MY);                                                      // the owner check finds another account
        expect(await b.m.db.loadOutboxFromDB()).toBeNull();                      // the disk is erased
        expect(b.queue().map((m) => m.id)).toEqual([theirs.id]);                 // DEFECT: still queued, will be sent
    });
});
