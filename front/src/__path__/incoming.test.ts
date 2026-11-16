import {describe, it, expect, afterEach, vi} from "vitest";
import {sources} from "virtual:repo-text";
import {bench, stop, row, sealed, type BenchOptions} from "./bench";

// Spec 003, scenario 6.5 (FR-053): a message that comes over the socket goes through steps that are modules
// of their own — into the chat, its secret text, the app is told, the server is told, read or unread — and
// each step has its test here, on the bench (the real store, the real modules). The text of a secret message
// is restored by one function, for the socket and for the history.

const MY = "me";
const PEER = "peer";
const CHAT = "c1";
const S1 = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const S2 = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
/** A server id of now: a secret message older than the time texts are kept is not decrypted from the history. */
const fresh = (n: number) => {
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let t = Date.now(), time = "";
    for (let i = 0; i < 10; i++) { time = alphabet[t % 32] + time; t = Math.floor(t / 32); }
    return time + String(n).padStart(16, "0");
};

type B = Awaited<ReturnType<typeof bench>>;

const msg = (id: string, body: string, o: {clientId?: string; from?: string; chat?: string} = {}) =>
    row({id, chat: o.chat ?? CHAT, from: o.from ?? PEER, to: MY, body, clientId: o.clientId});

/** Signed in, the socket connected, the chat open and read (empty). */
async function ready(opts: BenchOptions = {}): Promise<B> {
    const b = await bench(opts);
    b.server.chats([{id: CHAT, clientId: MY, masterId: PEER, clientReadReceipt: null, updatedAt: "2026-11-16T10:00:00Z"}]);
    await b.signIn(MY);
    b.socket.connect();
    const chat = b.open(CHAT);
    await b.server.history(CHAT).answer([]);
    await chat.read;
    return b;
}

/** The steps, from this start's module registry (the bench resets it). */
async function steps() {
    const [record, secretText, notify, acknowledge, mark] = await Promise.all([
        import("@/features/chat/incoming/record"),
        import("@/features/chat/incoming/secretText"),
        import("@/features/chat/incoming/notify"),
        import("@/features/chat/incoming/acknowledge"),
        import("@/features/chat/incoming/mark"),
    ]);
    return {...record, ...secretText, ...notify, ...acknowledge, ...mark};
}
const texts = (b: B) => (b.screen(CHAT) ?? []).map((r) => r.text);

/** The source text without comments. */
const code = (path: string) => sources[path].replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("6.5: the steps of an incoming message", () => {
    afterEach(() => { vi.restoreAllMocks(); return stop(); });

    it("6.5: the middleware only calls the steps; the library decrypts in one place", () => {
        const mw = code("/src/features/chat/middleware/chatMiddleware.ts");
        for (const step of ["recordIncoming(", "restoreSecretText(", "tellApp(", "acknowledge(", "markIncoming("]) expect(mw).toContain(step);
        for (const gone of ["secretCrypto", "notifyMessage", "buildChatAck", "markChatUnread", "socketRow(", "savePlaintext", "loadPlaintext"]) expect(mw).not.toContain(gone);
        // The secret text is restored by one function for both ways (FR-045): the library is called there only.
        const decrypts = Object.keys(sources)
            .filter((p) => p.startsWith("/src/features/chat/") && !/\.test\.tsx?$/.test(p) && !p.includes("__tests__"))
            .filter((p) => /secretCrypto\.decrypt\(/.test(code(p)));
        expect(decrypts).toEqual(["/src/features/chat/incoming/secretText.ts"]);
        expect(code("/src/features/chat/middleware/chatMiddleware.ts").match(/restoreSecretText\(/g)).toHaveLength(2);   // the socket, the history
    });

    it("6.5: record — the message is in the chat, a secret one says \"decrypting\" and turns the mode on; no chat — nothing", async () => {
        const b = await ready();
        const s = await steps();
        const m = s.recordIncoming(b.store, msg(S1, "hello", {clientId: "k1"}) as never);
        expect(m).toMatchObject({chatId: CHAT, sender: PEER, senderId: PEER, envelope: null, copy: false});
        expect(texts(b)).toEqual(["hello"]);

        const secret = s.recordIncoming(b.store, msg(S2, sealed("secret"), {clientId: "k2"}) as never);
        expect(secret?.envelope).toBe(sealed("secret"));
        expect(b.screen(CHAT)?.[1]).toMatchObject({id: S2, secret: true});
        expect(texts(b)[1]).not.toBe(sealed("secret"));
        expect(b.store.getState().secretChats.byId[CHAT]).toBe(true);

        // the peer's earlier build sends the same message again: a copy, still one row
        expect(s.recordIncoming(b.store, msg("01ARZ3NDEKTSV4RRFFQ69G5FA3", "hello", {clientId: "k1"}) as never)?.copy).toBe(true);
        expect(texts(b)).toHaveLength(2);
        expect(s.recordIncoming(b.store, {...msg(S1, "x"), conversationId: undefined} as never)).toBeNull();
    });

    it("6.5: secret text — the socket and the history restore it the same way: decrypted once, stored, found again", async () => {
        const b = await ready({app: true});
        const s = await steps();
        const id = fresh(1);
        const frame = msg(id, sealed("the text"), {clientId: "k1"});
        const m = s.recordIncoming(b.store, frame as never)!;
        const one = {chatId: CHAT, id, clientId: "k1", from: PEER, envelope: m.envelope!};
        // the socket and an answer of the history at the same moment
        const [bySocket, byHistory] = await Promise.all([s.restoreSecretText(b.store, one, "socket"), s.restoreSecretText(b.store, one, "history")]);
        expect([bySocket, byHistory]).toEqual([null, null]);
        expect(b.app.decrypted()).toEqual([sealed("the text")]);
        expect(texts(b)).toEqual(["the text"]);
        // a restart: the text is on the disk, the library is not asked again
        const again = await b.restart();
        await again.signIn(MY);
        const s2 = await steps();
        s2.recordIncoming(again.store, frame as never);
        await s2.restoreSecretText(again.store, one, "history");
        expect(again.app.decrypted()).toEqual([sealed("the text")]);
    });

    it("6.5: secret text — what cannot be decrypted: the history asks the sender, the socket only for a gap the sender can mend", async () => {
        const b = await ready({app: true});
        const s = await steps();
        const id = fresh(2);
        const one = {chatId: CHAT, id, clientId: "k9", from: PEER, envelope: sealed("spent")};
        s.recordIncoming(b.store, msg(id, sealed("spent"), {clientId: "k9"}) as never);
        await s.restoreSecretText(b.store, {...one, id: fresh(3), clientId: "k8"}, "socket");   // another message spends the key
        // a duplicate is not something the sender can mend: over the socket the row says "unavailable"
        expect(await s.restoreSecretText(b.store, one, "socket")).toBeNull();
        const unavailable = texts(b)[0];
        expect(unavailable).not.toBe("spent");
        // from the history the sender is asked for it
        expect(await s.restoreSecretText(b.store, one, "history")).toEqual({clientId: "k9", serverId: id});
        expect(texts(b)[0]).not.toBe(unavailable);
        // my own message in the history: the envelope is for the peer — the stored text or "unavailable"
        expect(await s.restoreSecretText(b.store, {...one, from: MY}, "history")).toBeNull();
        expect(texts(b)[0]).toBe(unavailable);
        expect(b.app.decrypted()).toHaveLength(3);                            // the spending one, the socket, the history; never my own
    });

    it("6.5: secret text — in a browser nothing is decrypted, the row says where it can be read", async () => {
        const b = await ready();
        const s = await steps();
        s.recordIncoming(b.store, msg(S1, sealed("x"), {clientId: "k1"}) as never);
        expect(await s.restoreSecretText(b.store, {chatId: CHAT, id: S1, clientId: "k1", from: PEER, envelope: sealed("x")}, "socket")).toBeNull();
        expect(texts(b)[0]).not.toBe(sealed("x"));
        expect(b.screen(CHAT)?.[0].secret).toBe(true);
    });

    it("6.5: notify — the app is told every message, with `hidden` when it is off the screen and not for a copy; a browser — nothing", async () => {
        const b = await ready({app: true});
        const s = await steps();
        const m = s.recordIncoming(b.store, msg(S1, "a", {clientId: "k1"}) as never)!;
        await s.tellApp(m, S1);
        b.page.hide();
        await s.tellApp(m, S1);
        await s.tellApp({...m, copy: true}, S1);
        expect(b.app.notified().map((n) => [n.messageId, n.senderId, n.hidden])).toEqual([[S1, PEER, false], [S1, PEER, true], [S1, PEER, false]]);
        await stop();

        const web = await ready();
        const w = await steps();
        expect(w.tellApp(w.recordIncoming(web.store, msg(S2, "b") as never)!, S2)).toBeUndefined();
    });

    it("6.5: acknowledge — at once without the app; after the app took it; never if it refused or is silent", async () => {
        const b = await ready();
        const s = await steps();
        const acks = () => b.socket.sent("CHAT_ACK").length;
        s.acknowledge(b.store, msg(S1, "a") as never, undefined);
        expect(acks()).toBe(1);
        s.acknowledge(b.store, msg(S2, "b") as never, Promise.resolve({shown: false}));
        expect(acks()).toBe(1);
        await b.until(() => acks() === 2, "the confirmation after the app's answer");
        s.acknowledge(b.store, msg(S2, "b") as never, Promise.reject(new Error("refused")));
        s.acknowledge(b.store, msg(S2, "b") as never, Promise.reject(Object.assign(new Error("no such method"), {code: "UNIMPLEMENTED"})));
        await b.until(() => acks() === 3, "the confirmation of an app without the method");
        vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
        try {
            s.acknowledge(b.store, msg(S2, "b") as never, new Promise(() => {}));
            await vi.advanceTimersByTimeAsync(s.NOTIFY_ANSWER_LIMIT_MS + 100);
        } finally { vi.useRealTimers(); }
        expect(acks()).toBe(3);
    });

    it("6.5: mark — the chat on the screen is read up to the message; another chat, or a hidden page, gets the mark; a copy nothing", async () => {
        const b = await ready();
        const s = await steps();
        const unread = () => Object.keys(b.store.getState().chatUi.unreadByChat).filter((c) => b.store.getState().chatUi.unreadByChat[c]).sort();
        const m = s.recordIncoming(b.store, msg(S1, "a") as never)!;
        s.markIncoming(b.store, msg(S1, "a") as never, m);
        expect(b.socket.sent("READ_IN").map((f) => f.correlationId)).toEqual([S1]);
        expect(unread()).toEqual([]);

        const other = s.recordIncoming(b.store, msg(S2, "b", {chat: "c2"}) as never)!;
        s.markIncoming(b.store, msg(S2, "b", {chat: "c2"}) as never, {...other, copy: true});
        expect(unread()).toEqual([]);
        s.markIncoming(b.store, msg(S2, "b", {chat: "c2"}) as never, other);
        expect(unread()).toEqual(["c2"]);

        b.page.hide();
        s.markIncoming(b.store, msg(S1, "a") as never, m);
        expect(unread()).toEqual(["c1", "c2"]);
        expect(b.socket.sent("READ_IN")).toHaveLength(1);
    });
});
