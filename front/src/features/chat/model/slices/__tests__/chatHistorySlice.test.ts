import {describe, it, expect} from "vitest";
import reducer, {
    ackTaken, answerTaken, chatCleared, diskTaken, echoPut, historyForgotten, historyStale, isStale, liveEpoch,
    olderTaken, readFailed, readStarted, rowFixed, rowRemoved, rowRestored, selectChatHistory, selectRows, socketRow,
    type ChatHistoryState,
} from "../chatHistorySlice";
import type {ChatMessage} from "@/features/chat/model/schema/domainChatMessage.schema";

// Spec 003, story 2 (T312): the reducer of the chats' messages, action by action.

const CHAT = "c1";
const ULID = (n: number) => "01ARZ3NDEKTSV4RRFFQ69G5F" + String(n).padStart(2, "0");
const row = (n: number, o: Partial<ChatMessage> = {}): ChatMessage =>
    ({id: ULID(n), chatId: CHAT, from: "peer", to: "me", text: `m${n}`, createdAt: new Date(1_700_000_000_000 + n), status: "sent", ...o});
const mine = (id: string, o: Partial<ChatMessage> = {}): ChatMessage =>
    ({id, clientId: id, chatId: CHAT, from: "me", to: "peer", text: id, createdAt: new Date(1_700_000_001_000), status: "pending", ...o});

const start = (): ChatHistoryState => reducer(undefined, {type: "@@init"});
const run = (state: ChatHistoryState, ...actions: Parameters<typeof reducer>[1][]) => actions.reduce(reducer, state);
const ids = (state: ChatHistoryState, chat = CHAT) => selectRows({chatHistory: state}, chat)?.map((m) => m.id);
const chat = (state: ChatHistoryState) => selectChatHistory({chatHistory: state}, CHAT)!;
/** A chat whose history was read: rows 1..n. */
const read = (n: number, epoch: number | null = 1) =>
    run(start(), readStarted({chatId: CHAT}), answerTaken({chatId: CHAT, answer: Array.from({length: n}, (_, i) => row(i + 1)), whole: false, epoch}));

describe("chatHistory: reading", () => {
    it("nothing is known about a chat until it is read", () => {
        expect(ids(start())).toBeUndefined();
        expect(selectRows({chatHistory: start()}, null)).toBeUndefined();
        expect(selectChatHistory({chatHistory: start()}, undefined)).toBeUndefined();
    });

    it("readStarted: the chat is being read and has no rows yet", () => {
        const s = run(start(), readStarted({chatId: CHAT}));
        expect(chat(s).reading).toBe(1);
        expect(ids(s)).toBeUndefined();
    });

    it("answerTaken: the first answer becomes the chat's rows; the read is over, no error", () => {
        const s = run(start(), readStarted({chatId: CHAT}), readFailed({chatId: CHAT}), readStarted({chatId: CHAT}),
            answerTaken({chatId: CHAT, answer: [row(1), row(2)], whole: false, epoch: 4}));
        expect(ids(s)).toEqual([ULID(1), ULID(2)]);
        expect(chat(s)).toMatchObject({reading: 0, error: false, readEpoch: 4, noOlder: false, answered: true});
    });

    it("answerTaken: an empty answer is an empty chat, not an unknown one", () => {
        const s = run(start(), readStarted({chatId: CHAT}), answerTaken({chatId: CHAT, answer: [], whole: true, epoch: null}));
        expect(ids(s)).toEqual([]);
        expect(chat(s).noOlder).toBe(true);        // the whole history: nothing older exists
    });

    it("answerTaken: an answer that proves nothing (epoch null) leaves the chat's connection as it was", () => {
        const s = run(read(1, 3), readStarted({chatId: CHAT}), answerTaken({chatId: CHAT, answer: [row(1)], whole: false, epoch: null}));
        expect(chat(s).readEpoch).toBe(3);
        expect(chat(run(start(), answerTaken({chatId: CHAT, answer: [], whole: true, epoch: null}))).readEpoch).toBeNull();
    });

    it("answerTaken: a row that came over the socket while the chat was read again stays", () => {
        const s = run(read(1), readStarted({chatId: CHAT}), socketRow({chatId: CHAT, row: row(2)}),
            answerTaken({chatId: CHAT, answer: [row(1)], whole: true, epoch: 1}));
        expect(ids(s)).toEqual([ULID(1), ULID(2)]);
    });

    it("answerTaken: a row that came over the socket BEFORE the read was sent and is not in the answer is gone", () => {
        const s = run(read(1), socketRow({chatId: CHAT, row: row(2)}), readStarted({chatId: CHAT}),
            answerTaken({chatId: CHAT, answer: [row(1)], whole: true, epoch: 1}));
        expect(ids(s)).toEqual([ULID(1)]);         // the server read its table after it: deleted there
    });

    it("answerTaken: rows held during the first read are merged with the answer, each once", () => {
        const s = run(start(), readStarted({chatId: CHAT}), socketRow({chatId: CHAT, row: row(2)}), socketRow({chatId: CHAT, row: row(3)}),
            answerTaken({chatId: CHAT, answer: [row(1), row(2)], whole: true, epoch: 1}));
        expect(ids(s)).toEqual([ULID(1), ULID(2), ULID(3)]);
        expect(chat(s).held).toEqual([]);
    });

    it("answerTaken: my queued messages are put in and kept", () => {
        const s = run(read(1), readStarted({chatId: CHAT}),
            answerTaken({chatId: CHAT, answer: [row(1)], whole: true, epoch: 1, queued: [mine("q1")]}));
        expect(ids(s)).toEqual([ULID(1), "q1"]);
    });

    it("answerTaken: a queued message already shown as a row that looks sent is kept under its row", () => {
        // the echo is put with the status "sent" (chatMessages.service); only the queue knows it is not
        const s = run(read(1), echoPut({chatId: CHAT, row: mine("q1", {status: "sent"})}), readStarted({chatId: CHAT}),
            answerTaken({chatId: CHAT, answer: [row(1)], whole: true, epoch: 1, queued: [mine("q1")]}));
        expect(ids(s)).toEqual([ULID(1), "q1"]);
    });

    it("answerTaken: with two reads on their way, what arrived is remembered until the last one ends", () => {
        const s1 = run(read(1), readStarted({chatId: CHAT}), readStarted({chatId: CHAT}), socketRow({chatId: CHAT, row: row(2)}),
            answerTaken({chatId: CHAT, answer: [row(1)], whole: true, epoch: 1}));
        expect(chat(s1)).toMatchObject({reading: 1, arrived: [ULID(2)]});
        const s2 = run(s1, answerTaken({chatId: CHAT, answer: [row(1)], whole: true, epoch: 1}));
        expect(ids(s2)).toEqual([ULID(1), ULID(2)]);
        expect(chat(s2)).toMatchObject({reading: 0, arrived: []});
    });

    it("readFailed: the chat keeps what it has and says the read failed", () => {
        const s = run(read(2), readStarted({chatId: CHAT}), socketRow({chatId: CHAT, row: row(3)}), readFailed({chatId: CHAT}));
        expect(ids(s)).toEqual([ULID(1), ULID(2), ULID(3)]);
        expect(chat(s)).toMatchObject({reading: 0, error: true, arrived: [], readEpoch: 1});
    });

    it("readFailed: a chat never read has no rows, only the error", () => {
        const s = run(start(), readStarted({chatId: CHAT}), readFailed({chatId: CHAT}));
        expect(ids(s)).toBeUndefined();
        expect(chat(s).error).toBe(true);
    });
});

describe("chatHistory: the socket", () => {
    it("socketRow: written to a chat whose rows are in, once per message", () => {
        const s = run(read(1), socketRow({chatId: CHAT, row: row(2)}), socketRow({chatId: CHAT, row: row(2)}));
        expect(ids(s)).toEqual([ULID(1), ULID(2)]);
        expect(chat(s).arrived).toEqual([]);       // no read on its way: nothing to remember
    });

    it("socketRow: a resend stored under a new server id is the same message (client id)", () => {
        const s = run(read(1), socketRow({chatId: CHAT, row: row(2, {clientId: "k"})}), socketRow({chatId: CHAT, row: row(3, {clientId: "k"})}));
        expect(ids(s)).toEqual([ULID(1), ULID(2)]);
    });

    it("socketRow: held while the chat is read for the first time", () => {
        const s = run(start(), readStarted({chatId: CHAT}), socketRow({chatId: CHAT, row: row(1)}));
        expect(ids(s)).toBeUndefined();
        expect(chat(s).held.map((m) => m.id)).toEqual([ULID(1)]);
        expect(chat(s).arrived).toEqual([ULID(1)]);
    });

    it("socketRow: a chat that was never opened takes nothing — it reads the server when opened", () => {
        expect(run(start(), socketRow({chatId: CHAT, row: row(1)})).byChat[CHAT]).toBeUndefined();
        // a chat whose only read has failed: no rows and nothing on its way
        const failed = run(start(), readStarted({chatId: CHAT}), readFailed({chatId: CHAT}), socketRow({chatId: CHAT, row: row(1)}));
        expect(ids(failed)).toBeUndefined();
        expect(chat(failed).held).toEqual([]);
    });

    it("ackTaken: my row gets the server's id and time, found by the client id", () => {
        const s = run(read(1), echoPut({chatId: CHAT, row: mine("q1")}), ackTaken({chatId: CHAT, clientId: "q1", serverId: ULID(9), at: 1_700_000_005_000}));
        const acked = selectRows({chatHistory: s}, CHAT)!.at(-1)!;
        expect(acked).toMatchObject({id: ULID(9), clientId: "q1"});
        expect(acked.createdAt.getTime()).toBe(1_700_000_005_000);
    });

    it("ackTaken: only the id, or only the time", () => {
        const base = run(read(1), echoPut({chatId: CHAT, row: mine("q1")}));
        const onlyTime = selectRows({chatHistory: run(base, ackTaken({chatId: CHAT, clientId: "q1", at: 5}))}, CHAT)!.at(-1)!;
        expect(onlyTime.id).toBe("q1");
        expect(onlyTime.createdAt.getTime()).toBe(5);
        const onlyId = selectRows({chatHistory: run(base, ackTaken({chatId: CHAT, clientId: "q1", serverId: ULID(9)}))}, CHAT)!.at(-1)!;
        expect(onlyId.id).toBe(ULID(9));
        expect(onlyId.createdAt.getTime()).toBe(1_700_000_001_000);
    });

    it("ackTaken: during a read the confirmed row is remembered — the answer may have left before it was stored", () => {
        const s = run(read(1), echoPut({chatId: CHAT, row: mine("q1", {status: "sent"})}), readStarted({chatId: CHAT}),
            ackTaken({chatId: CHAT, clientId: "q1", serverId: ULID(9)}),
            answerTaken({chatId: CHAT, answer: [row(1)], whole: true, epoch: 1}));
        expect(ids(s)).toEqual([ULID(1), ULID(9)]);
    });

    it("ackTaken: a chat or a row that is not there changes nothing", () => {
        expect(run(start(), ackTaken({chatId: CHAT, clientId: "q1", serverId: ULID(9)}))).toEqual(start());
        const s = read(1);
        expect(run(s, ackTaken({chatId: CHAT, clientId: "nobody", serverId: ULID(9)}))).toEqual(s);
    });
});

describe("chatHistory: the other writers", () => {
    it("olderTaken: an older page goes before the rows, without the rows already there", () => {
        const base = run(start(), readStarted({chatId: CHAT}), answerTaken({chatId: CHAT, answer: [row(3), row(4)], whole: false, epoch: 1}));
        const s = run(base, olderTaken({chatId: CHAT, rows: [row(1), row(2), row(3)], noOlder: false}));
        expect(ids(s)).toEqual([ULID(1), ULID(2), ULID(3), ULID(4)]);
        expect(chat(s).noOlder).toBe(false);
    });

    it("olderTaken: the server has nothing older — remembered; a chat without rows takes no page", () => {
        expect(chat(run(read(2), olderTaken({chatId: CHAT, rows: [], noOlder: true}))).noOlder).toBe(true);
        expect(run(start(), olderTaken({chatId: CHAT, rows: [row(1)], noOlder: true}))).toEqual(start());
    });

    it("diskTaken: the device's copy is shown until the server answers", () => {
        const s = run(start(), diskTaken({chatId: CHAT, rows: [row(1), row(2)]}));
        expect(ids(s)).toEqual([ULID(1), ULID(2)]);
        expect(chat(s).answered).toBe(false);
        const answered = run(s, readStarted({chatId: CHAT}), answerTaken({chatId: CHAT, answer: [row(2), row(3)], whole: true, epoch: 1}));
        expect(ids(answered)).toEqual([ULID(2), ULID(3)]);
        expect(chat(answered).answered).toBe(true);
    });

    it("diskTaken: never after an answer of the server; what the chat took before the disk was read stays", () => {
        const s = run(read(2), diskTaken({chatId: CHAT, rows: [row(7)]}));
        expect(ids(s)).toEqual([ULID(1), ULID(2)]);
        const early = run(start(), echoPut({chatId: CHAT, row: mine("q1")}), diskTaken({chatId: CHAT, rows: [row(1), row(2)]}));
        expect(ids(early)).toEqual([ULID(1), ULID(2), "q1"]);
    });

    it("echoPut: my message is shown at once, once; also in a chat that has no rows yet", () => {
        const s = run(read(1), echoPut({chatId: CHAT, row: mine("q1")}), echoPut({chatId: CHAT, row: mine("q1")}));
        expect(ids(s)).toEqual([ULID(1), "q1"]);
        const unread = run(start(), echoPut({chatId: CHAT, row: mine("q1")}));
        expect(ids(unread)).toEqual(["q1"]);
        expect(chat(unread).answered).toBe(false);
    });

    it("rowFixed: changes the named fields of one row, found by id or by client id", () => {
        const base = run(read(2), echoPut({chatId: CHAT, row: mine("q1")}));
        const byId = run(base, rowFixed({chatId: CHAT, id: ULID(2), fix: {text: "plain", secret: true}}));
        expect(selectRows({chatHistory: byId}, CHAT)![1]).toMatchObject({id: ULID(2), text: "plain", secret: true});
        expect(selectRows({chatHistory: byId}, CHAT)![0]).toEqual(row(1));
        const byClientId = run(base, rowFixed({chatId: CHAT, clientId: "q1", fix: {unsaved: true}}));
        expect(selectRows({chatHistory: byClientId}, CHAT)![2]).toMatchObject({id: "q1", unsaved: true});
    });

    it("rowFixed: reaches a row held during the first read, so its text is right when the answer comes", () => {
        const s = run(start(), readStarted({chatId: CHAT}), socketRow({chatId: CHAT, row: row(1, {text: "…", secret: true})}),
            rowFixed({chatId: CHAT, id: ULID(1), fix: {text: "plain"}}),
            answerTaken({chatId: CHAT, answer: [], whole: true, epoch: 1}));
        expect(selectRows({chatHistory: s}, CHAT)).toMatchObject([{id: ULID(1), text: "plain", secret: true}]);
    });

    it("rowFixed: a chat or a row that is not there changes nothing", () => {
        expect(run(start(), rowFixed({chatId: CHAT, id: ULID(1), fix: {text: "x"}}))).toEqual(start());
        const s = read(1);
        expect(run(s, rowFixed({chatId: CHAT, id: ULID(5), fix: {text: "x"}}))).toEqual(s);
        expect(run(s, rowFixed({chatId: CHAT, fix: {text: "x"}}))).toEqual(s);      // no id at all names no row
    });

    it("rowRemoved: one row is taken out, by id or by client id", () => {
        const base = run(read(2), echoPut({chatId: CHAT, row: mine("q1")}));
        expect(ids(run(base, rowRemoved({chatId: CHAT, id: ULID(1)})))).toEqual([ULID(2), "q1"]);
        expect(ids(run(base, rowRemoved({chatId: CHAT, clientId: "q1"})))).toEqual([ULID(1), ULID(2)]);
        expect(run(base, rowRemoved({chatId: CHAT, id: "nobody"}))).toEqual(base);
        expect(run(start(), rowRemoved({chatId: CHAT, id: ULID(1)}))).toEqual(start());
    });

    it("rowRestored: the row goes back to the place it had; never twice, never into a chat without rows", () => {
        const removed = run(read(3), rowRemoved({chatId: CHAT, id: ULID(2)}));
        const s = run(removed, rowRestored({chatId: CHAT, row: row(2), index: 1}));
        expect(ids(s)).toEqual([ULID(1), ULID(2), ULID(3)]);
        expect(run(s, rowRestored({chatId: CHAT, row: row(2), index: 0}))).toEqual(s);
        expect(ids(run(removed, rowRestored({chatId: CHAT, row: row(2), index: 99})))).toEqual([ULID(1), ULID(3), ULID(2)]);
        expect(run(start(), rowRestored({chatId: CHAT, row: row(2), index: 0}))).toEqual(start());
    });

    it("chatCleared: no rows and nothing older; a chat never read stays unknown", () => {
        const s = run(read(2), chatCleared({chatId: CHAT}));
        expect(ids(s)).toEqual([]);
        expect(chat(s).noOlder).toBe(true);
        expect(run(start(), chatCleared({chatId: CHAT}))).toEqual(start());
    });

    it("historyForgotten: nothing of the chats stays in memory", () => {
        expect(run(read(2), historyForgotten())).toEqual(start());
    });
});

// Before story 2 this rule and its tests were a module of their own.
describe("chatHistory: the sign that the socket had a gap (spec 002 §3.1)", () => {
    const up = (epoch: number) => ({status: "connected", epoch});
    const down = (epoch: number) => ({status: "disconnected", epoch});
    const stale = (state: ChatHistoryState, ws: {status: string; epoch: number}, chatId = CHAT) => isStale({chatHistory: state, ws}, chatId);
    const readUnder = (state: ChatHistoryState, chatId: string, epoch: number | null) =>
        run(state, readStarted({chatId}), answerTaken({chatId, answer: [], whole: true, epoch}));

    it("liveEpoch: the connection number only while the socket is connected", () => {
        expect(liveEpoch(up(3))).toBe(3);
        expect(liveEpoch(down(3))).toBeNull();
        expect(liveEpoch(undefined)).toBeNull();
        expect(liveEpoch({status: "connected"})).toBeNull();
    });

    it("a chat never read is stale; read under the live connection it is complete", () => {
        expect(stale(start(), up(1))).toBe(true);
        const s = readUnder(start(), CHAT, 1);
        expect(stale(s, up(1))).toBe(false);
        expect(stale(s, up(1), "c2")).toBe(true);      // another chat is not covered
    });

    it("any gap makes every chat stale: a new connection number, whatever the reason", () => {
        const s = readUnder(readUnder(start(), CHAT, 1), "c2", 1);
        expect(stale(s, down(1))).toBe(true);          // while the socket is down nothing is provable
        expect(stale(s, up(2))).toBe(true);
        expect(stale(s, up(2), "c2")).toBe(true);
    });

    it("a read that proves nothing (the socket was down, or changed meanwhile) leaves the chat stale", () => {
        expect(stale(readUnder(start(), CHAT, null), up(2))).toBe(true);
    });

    it("a failed read leaves the chat stale", () => {
        expect(stale(run(start(), readStarted({chatId: CHAT}), readFailed({chatId: CHAT})), up(1))).toBe(true);
    });

    it("historyStale: a push or a tap marks one chat stale under a live connection", () => {
        const s = run(readUnder(readUnder(start(), CHAT, 3), "c2", 3), historyStale({chatId: CHAT}));
        expect(stale(s, up(3))).toBe(true);
        expect(stale(s, up(3), "c2")).toBe(false);
        expect(run(start(), historyStale({chatId: CHAT}))).toEqual(start());      // a chat never read is stale already
    });
});
