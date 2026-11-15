import {describe, it, expect, afterEach} from "vitest";
import {bench, stop, row} from "./bench";

// Audit 2026-11-14 (specs/002-reliable-delivery/audit.md), findings A1–A7, on the bench of spec 003.
// Every test here states the behaviour AS IT IS NOW — a defect. The pull request that fixes a defect turns
// its test over and gives it the number of its scenario (specs/003-message-path/test-matrix.md).
// Turned over so far: A1, A2, A6, A5 — scenarios 2.1, 2.2, 2.3, 2.4 in history.test.ts.

const MY = "me";
const PEER = "peer";
const CHAT = "c1";
const M1 = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const msg = (id: string, from: string, body: string) => row({id, chat: CHAT, from, to: from === MY ? PEER : MY, body});

describe("1.2: the audit findings A1–A7 run on the bench", () => {
    afterEach(stop);

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
