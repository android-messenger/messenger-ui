import {describe, it, expect, afterEach} from "vitest";
import {bench, stop, row} from "./bench";

// Spec 003, scenario 1.1: the bench plays the server, the socket and the app; the rest is the application.

const MY = "me";
const PEER = "peer";
const CHAT = "c1";
const M1 = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const incomingMessage = row({id: M1, chat: CHAT, from: PEER, to: MY, body: "hello"});

describe("1.1: the bench plays the server, the socket and the app; everything else is real", () => {
    afterEach(stop);

    it("1.1: the socket — nothing connects without a user; frames go both ways; every connection has its number", async () => {
        const b = await bench();
        expect(() => b.socket.connect()).toThrow(/not connecting/);      // the real middleware refuses without a user
        await b.signIn(MY);
        expect(b.socket.connect()).toBe(1);
        expect(b.store.getState().ws).toMatchObject({status: "connected", epoch: 1});

        b.socket.frame(incomingMessage);                                  // the real handlers acknowledge it
        expect(b.socket.sentWithConnection()).toEqual([{connection: 1, frame: expect.objectContaining({type: "CHAT_ACK"})}]);
        expect(b.store.getState().chatUi.unreadByChat[CHAT]).toBe(true);  // and mark the closed chat unread

        b.socket.drop();
        expect(b.socket.isOpen()).toBe(false);
        expect(b.store.getState().ws.status).toBe("disconnected");
        expect(b.socket.connect()).toBe(2);
        expect(b.store.getState().ws.epoch).toBe(2);
    });

    it("1.1: the server — a history request waits for the test's answer; a failure and a 401 reach the real handlers", async () => {
        const b = await bench();
        await b.signIn(MY);
        const chat = b.open(CHAT);
        await b.until(() => b.server.history(CHAT).waiting() === 1, "the request");
        expect(b.screen(CHAT)).toBeUndefined();
        await b.server.history(CHAT).answer([incomingMessage]);
        await chat.read;
        expect(b.screen(CHAT)?.map((m) => m.text)).toEqual(["hello"]);

        const again = chat.reread();
        await b.server.history(CHAT).fail();
        await again;
        expect(b.readFailed(CHAT)).toBe(true);

        const expired = chat.reread();
        await b.server.history(CHAT).status(401);                         // the real 401 listener signs the user out
        await expired;
        await b.until(() => b.store.getState().user.id !== MY, "the user to be cleared");
        expect(b.errors()).toHaveLength(1);
        expect(b.server.history(CHAT).asked()).toBe(3);
    });

    it("1.1: the disk — a restart starts the application anew on the same device", async () => {
        const first = await bench();
        await first.signIn(MY);
        first.store.dispatch(first.m.outbox.enqueueMessage(first.m.mapper.toOutboxMessage({conversationId: CHAT, recipientId: PEER, text: "queued"})));
        await first.until(() => first.store.getState().outbox.persistedVersion === first.store.getState().outbox.outboxVersion, "the queue on disk");

        const b = await first.restart();
        expect(b.store).not.toBe(first.store);
        expect(b.m.sync).not.toBe(first.m.sync);                          // module state starts empty
        expect(b.store.getState().user.id).not.toBe(MY);                  // nobody is signed in yet
        expect(b.queue().map((m) => m.payload.payload?.body)).toEqual(["queued"]);
    });

    it("1.1: the disk — what the killed application had not handed to the disk is lost", async () => {
        const first = await bench();
        await first.signIn(MY);
        first.store.dispatch(first.m.outbox.enqueueMessage(first.m.mapper.toOutboxMessage({conversationId: CHAT, recipientId: PEER, text: "queued"})));
        const b = await first.restart();                                  // killed before the delayed write
        await b.settle(600);
        expect(b.queue()).toEqual([]);
        expect(await b.m.db.loadOutboxFromDB()).toBeNull();
    });

    it("1.1: the app — records go through the Vault; a locked phone holds the queue back until it is unlocked", async () => {
        const first = await bench({app: true});
        await first.signIn(MY);
        first.store.dispatch(first.m.outbox.enqueueMessage(first.m.mapper.toOutboxMessage({conversationId: CHAT, recipientId: PEER, text: "queued"})));
        await first.until(() => first.store.getState().outbox.persistedVersion === first.store.getState().outbox.outboxVersion, "the queue on disk");

        first.app.lock();
        const b = await first.restart();
        expect(b.m.lists.listsReady()).toBe(false);                       // nothing is sent or written yet
        expect(b.queue()).toEqual([]);
        b.app.unlock();
        await b.until(() => b.m.lists.listsReady(), "the lists");
        expect(b.queue().map((m) => m.payload.payload?.body)).toEqual(["queued"]);
    });

    it("1.1: the app — is told about a message from the socket; the page can be hidden", async () => {
        const b = await bench({app: true});
        await b.signIn(MY);
        b.socket.connect();
        b.page.hide();
        b.socket.frame(incomingMessage);
        expect(b.app.notified()).toEqual([{conversationId: CHAT, messageId: M1, senderId: PEER, hidden: true}]);
        b.page.show();
        expect(document.hidden).toBe(false);
    });
});
