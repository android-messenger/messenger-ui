import {describe, it, expect} from "vitest";
import {mergeHistory} from "../mergeHistory";
import type {ChatMessage} from "../schema/domainChatMessage.schema";

// Spec 003, T310: the rule of the merge, as a table. No store, no network.

const ulid = (n: number) => "01ARZ3NDEKTSV4RRFFQ69G" + String(n).padStart(4, "0");
const T0 = 1_700_000_000_000;

/** A row the server stored: `s(3)` is the third message of the chat. */
const s = (n: number, more: Partial<ChatMessage> = {}): ChatMessage =>
    ({id: ulid(n), chatId: "c1", from: "peer", to: "me", text: `m${n}`, createdAt: new Date(T0 + n * 1000), status: "sent", ...more});
/** My message that is still to be sent: its id is the client's. */
const mine = (clientId: string, at: number, more: Partial<ChatMessage> = {}): ChatMessage =>
    ({id: clientId, clientId, chatId: "c1", from: "me", to: "peer", text: `mine ${clientId}`, createdAt: new Date(T0 + at * 1000), status: "pending", ...more});

const ids = (rows: ChatMessage[]) => rows.map((m) => m.id);
const none = new Set<string>();

interface Case {
    name: string;
    current: ChatMessage[];
    answer: ChatMessage[];
    whole?: boolean;
    arrived?: string[];
    want: string[];
}

const cases: Case[] = [
    // --- the answer alone ---
    {name: "an empty chat takes the answer", current: [], answer: [s(1), s(2)], want: [ulid(1), ulid(2)]},
    {name: "an empty answer to an empty chat is an empty chat", current: [], answer: [], whole: true, want: []},
    {name: "the same rows again change nothing", current: [s(1), s(2)], answer: [s(1), s(2)], want: [ulid(1), ulid(2)]},
    {name: "new rows of the answer are added", current: [s(1)], answer: [s(1), s(2), s(3)], want: [ulid(1), ulid(2), ulid(3)]},
    {name: "the answer repeats a row: one row", current: [], answer: [s(1), s(1), s(2)], want: [ulid(1), ulid(2)]},

    // --- FR-011: the socket was faster than the answer ---
    {name: "a row from the socket, newer than the answer, stays", current: [s(1), s(2)], answer: [s(1)], arrived: [ulid(2)], want: [ulid(1), ulid(2)]},
    {name: "a row from the socket stays after an empty answer", current: [s(1)], answer: [], whole: true, arrived: [ulid(1)], want: [ulid(1)]},
    {name: "two rows from the socket stay, in the order of their time", current: [s(1), s(3), s(2)], answer: [s(1)], arrived: [ulid(2), ulid(3)], want: [ulid(1), ulid(2), ulid(3)]},
    {name: "a row from the socket that is also in the answer is one row", current: [s(1), s(2)], answer: [s(1), s(2)], arrived: [ulid(2)], want: [ulid(1), ulid(2)]},
    {name: "a row from the socket in a chat read for the first time stays", current: [s(5)], answer: [s(1), s(2)], arrived: [ulid(5)], want: [ulid(1), ulid(2), ulid(5)]},

    // --- FR-017: what the server no longer has ---
    {name: "a row inside the range that the answer lacks is removed", current: [s(1), s(2), s(3)], answer: [s(1), s(3)], want: [ulid(1), ulid(3)]},
    {name: "the newest row, shown before the request and absent from the answer, is removed", current: [s(1), s(2)], answer: [s(1)], want: [ulid(1)]},
    {name: "a cleared chat: an empty whole answer removes every stored row", current: [s(1), s(2)], answer: [], whole: true, want: []},
    {name: "a cleared chat keeps the row that came during the request", current: [s(1), s(2), s(3)], answer: [], whole: true, arrived: [ulid(3)], want: [ulid(3)]},

    // --- FR-016: older pages ---
    {name: "rows older than a full page stay", current: [s(1), s(2), s(3), s(4)], answer: [s(3), s(4)], want: [ulid(1), ulid(2), ulid(3), ulid(4)]},
    {name: "rows older than the WHOLE history are removed", current: [s(1), s(2), s(3)], answer: [s(2), s(3)], whole: true, want: [ulid(2), ulid(3)]},
    {name: "older rows stay and a deleted row inside the page goes", current: [s(1), s(2), s(3), s(4)], answer: [s(2), s(4)], want: [ulid(1), ulid(2), ulid(4)]},

    // --- FR-015: my unsent messages ---
    {name: "my pending message stays after the answer", current: [s(1), mine("q1", 9)], answer: [s(1)], want: [ulid(1), "q1"]},
    {name: "my failed message stays", current: [mine("q1", 9, {status: "failed"})], answer: [], whole: true, want: ["q1"]},
    {name: "my pending message stays in a cleared chat", current: [s(1), mine("q1", 9)], answer: [], whole: true, want: ["q1"]},
    {name: "pending messages keep their order", current: [mine("q2", 8), mine("q1", 7)], answer: [s(1)], want: [ulid(1), "q1", "q2"]},

    // --- FR-034: one message, one row ---
    {name: "my echo and its row in the answer are one row, under the server's id", current: [mine("q1", 9)], answer: [s(1, {from: "me", to: "peer", clientId: "q1"})], want: [ulid(1)]},
    {name: "an echo already given its server id and the answer's row are one row", current: [mine("q1", 9, {id: ulid(1), status: "sent"})], answer: [s(1, {clientId: "q1"})], want: [ulid(1)]},
    {name: "a resend stored twice under one client id is one row", current: [], answer: [s(1, {clientId: "q1"}), s(2, {clientId: "q1"})], want: [ulid(1)]},
    {name: "a socket row and an answer row of one client id under two server ids are one row", current: [s(2, {clientId: "q1"})], answer: [s(1, {clientId: "q1"})], arrived: [ulid(2)], want: [ulid(1)]},
    {name: "the same text under another client id is another message", current: [mine("q2", 9, {text: "ok"})], answer: [s(1, {from: "me", to: "peer", clientId: "q1", text: "ok"})], want: [ulid(1), "q2"]},
];

describe("mergeHistory", () => {
    it.each(cases)("$name", ({current, answer, whole = false, arrived = [], want}) => {
        expect(ids(mergeHistory({current, answer, whole, arrived: new Set(arrived)}))).toEqual(want);
    });

    it("has at least twenty cases", () => {
        expect(cases.length).toBeGreaterThanOrEqual(20);
    });

    it("FR-018: the time of a row comes from the answer", () => {
        const fromSocket = s(1, {createdAt: new Date(T0 + 999_000)});
        const [row] = mergeHistory({current: [fromSocket], answer: [s(1)], whole: true, arrived: new Set([ulid(1)])});
        expect(row.createdAt.getTime()).toBe(T0 + 1000);
    });

    it("FR-018: the order does not depend on the clock of the socket frame", () => {
        const late = s(2, {createdAt: new Date(T0)});   // its frame carried an earlier time than message 1
        expect(ids(mergeHistory({current: [late, s(1)], answer: [s(1), s(2)], whole: true, arrived: none}))).toEqual([ulid(1), ulid(2)]);
    });

    it("FR-019: a secret message keeps the text this device decrypted, and its marks", () => {
        const shown = s(1, {text: "the plain text", secret: true, unsaved: true});
        const [row] = mergeHistory({current: [shown], answer: [s(1, {text: "{\"e2ee\":\"envelope\"}"})], whole: true, arrived: none});
        expect(row).toMatchObject({id: ulid(1), text: "the plain text", secret: true, unsaved: true});
    });

    it("a message that is not secret takes the text of the answer", () => {
        const [row] = mergeHistory({current: [s(1, {text: "old"})], answer: [s(1, {text: "new"})], whole: true, arrived: none});
        expect(row.text).toBe("new");
    });

    it("the answer's row keeps the client id the device knows", () => {
        const [row] = mergeHistory({current: [mine("q1", 9, {id: ulid(1), status: "sent"})], answer: [s(1)], whole: true, arrived: none});
        expect(row).toMatchObject({id: ulid(1), clientId: "q1"});
    });

    it("rows without server ids are placed by time", () => {
        const legacy = (id: string, at: number): ChatMessage => ({...s(1), id, createdAt: new Date(T0 + at)});
        expect(ids(mergeHistory({current: [legacy("a", 1), legacy("b", 2), legacy("c", 3)], answer: [legacy("b", 2), legacy("c", 3)], whole: false, arrived: none})))
            .toEqual(["a", "b", "c"]);
    });

    it("does not change what it was given", () => {
        const current = [s(1), s(2)];
        const answer = [s(1)];
        const before = JSON.stringify([current, answer]);
        mergeHistory({current, answer, whole: false, arrived: new Set([ulid(2)])});
        expect(JSON.stringify([current, answer])).toBe(before);
    });
});
