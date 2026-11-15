import {describe, it, expect, afterEach, vi} from "vitest";
import {act, renderHook} from "@testing-library/react";
import toast from "react-hot-toast";
import {bench, stop, row} from "./bench";

// Spec 003, story 4 — a message sent once is one row and one notification: the interface does not send
// the same frame twice over one connection, a confirmation finds its own chat, an attachment whose
// confirmation was lost is not offered again, and repeats from a peer on an earlier build are one row.

const MY = "me";
const PEER = "peer";
const CHAT = "c1";
const OTHER = "c2";
const S1 = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const S2 = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
const S3 = "01ARZ3NDEKTSV4RRFFQ69G5FA3";
const OLD = "01ARZ3NDEKTSV4RRFFQ69G5F00";
const OLD2 = "01ARZ3NDEKTSV4RRFFQ69G5F01";

type B = Awaited<ReturnType<typeof bench>>;

function send(b: B, text: string, chat = CHAT) {
    return b.m.service.chatMessagesService.enqueueChatMessage(b.store.dispatch, text, MY, chat, PEER, undefined, false) as Promise<unknown>;
}
const flush = (b: B) => b.store.dispatch(b.m.flush.flushOutbox());
const ids = (b: B) => b.queue().map((m) => m.id);
const statuses = (b: B) => b.queue().map((m) => m.status);
/** The CHAT_IN frames that went out: [connection, client id]. */
const chatIn = (b: B) => b.socket.sentWithConnection().filter((f) => f.frame.type === "CHAT_IN").map((f) => [f.connection, f.frame.messageId]);
const ack = (b: B, clientId: string, serverId: string, more: Record<string, unknown> = {}) =>
    b.socket.frame({type: "CHAT_ACK", correlationId: clientId, serverMessageId: serverId, serverTimestamp: 1_700_000_000_000, ...more});

/** A clock the test moves: the queue measures its waits by Date.now(). */
function clock() {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    return {pass(ms: number) { now += ms; }};
}

async function connected(): Promise<B> {
    const b = await bench();
    await b.signIn(MY);
    b.socket.connect();
    return b;
}

describe("story 4: one message is one row and one notification", () => {
    afterEach(() => { vi.restoreAllMocks(); return stop(); });

    it("4.1: a message with no confirmation is not sent a second time over the same connection", async () => {
        const b = await connected();
        const time = clock();
        await send(b, "once");
        const [id] = ids(b);
        expect(chatIn(b)).toEqual([[1, id]]);

        for (let i = 0; i < 5; i++) {                                            // the queue is looked at every 3 s
            time.pass(3_000);
            await flush(b);
        }
        expect(chatIn(b)).toEqual([[1, id]]);
        expect(statuses(b)).toEqual(["sending"]);
    });

    it("4.2: on a new connection it goes out once more, once per connection, under the same client id", async () => {
        const b = await connected();
        await send(b, "once per connection");
        const [id] = ids(b);

        b.socket.drop();
        await flush(b);                                                          // no connection: nothing goes
        expect(chatIn(b)).toEqual([[1, id]]);

        b.socket.connect();
        await flush(b);
        await flush(b);
        expect(chatIn(b)).toEqual([[1, id], [2, id]]);

        b.socket.drop();
        b.socket.connect();
        await flush(b);
        await flush(b);
        expect(chatIn(b)).toEqual([[1, id], [2, id], [3, id]]);

        ack(b, id, S1);
        expect(b.queue()).toEqual([]);
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([S1]);
    });

    it("4.2: a message that was on its way when the app was killed goes out again after the restart", async () => {
        const first = await connected();
        await send(first, "sent, then the app was killed");
        const [id] = ids(first);
        for (let i = 0; i < 300 && (await first.m.db.loadOutboxFromDB())?.messages[0]?.status !== "sending"; i++) await first.settle(5);

        const b = await first.restart();
        await b.signIn(MY);
        expect(ids(b)).toEqual([id]);
        b.socket.connect();                                                      // the first connection of this start, as before the kill
        await flush(b);
        await flush(b);
        expect(chatIn(b)).toEqual([[1, id], [2, id]]);
    });

    it("4.3: no confirmation for longer than the limit on a living connection — not sent; \"retry\" sends the same client id, \"discard\" removes it", async () => {
        const b = await connected();
        const chat = b.open(CHAT);
        await b.server.history(CHAT).answer([]);
        await chat.read;
        const {OUTBOX_SEND_TIMEOUT_MS} = await import("@/shared/config/outbox");
        const {useOutboxStatus} = await import("@/features/chat/hooks/useOutboxStatus");
        const view = renderHook(() => useOutboxStatus({selectedChatId: CHAT}), {wrapper: b.wrapper});
        const time = clock();
        await send(b, "never confirmed");
        const [id] = ids(b);

        time.pass(OUTBOX_SEND_TIMEOUT_MS - 1_000);
        await flush(b);
        expect(statuses(b)).toEqual(["sending"]);
        time.pass(1_000);
        await flush(b);
        expect(statuses(b)).toEqual(["failed"]);
        expect(view.result.current.outboxStatusById).toEqual({[id]: "failed"});
        time.pass(60_000);
        await flush(b);
        expect(chatIn(b)).toEqual([[1, id]]);                                    // given up: not sent again by itself

        await act(async () => { view.result.current.retryMessage(id); await b.settle(); });
        expect(chatIn(b)).toEqual([[1, id], [1, id]]);
        expect(statuses(b)).toEqual(["sending"]);

        time.pass(OUTBOX_SEND_TIMEOUT_MS);
        await flush(b);
        expect(statuses(b)).toEqual(["failed"]);
        act(() => { view.result.current.discardMessage(id); });
        expect(b.queue()).toEqual([]);
        expect(b.screen(CHAT)).toEqual([]);
        view.unmount();
    });

    it("4.3: a confirmation that comes after the limit still takes the message as sent", async () => {
        const b = await connected();
        const {OUTBOX_SEND_TIMEOUT_MS} = await import("@/shared/config/outbox");
        const time = clock();
        await send(b, "confirmed late");
        const [id] = ids(b);
        time.pass(OUTBOX_SEND_TIMEOUT_MS);
        await flush(b);
        expect(statuses(b)).toEqual(["failed"]);
        ack(b, id, S1);
        expect(b.queue()).toEqual([]);
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([S1]);
    });

    it("4.3: a message that waits for a connection is not given up, however long it waits", async () => {
        const b = await bench();
        await b.signIn(MY);
        const time = clock();
        await send(b, "written without a connection");
        time.pass(3_600_000);
        await flush(b);
        expect(statuses(b)).toEqual(["pending"]);
        b.socket.connect();
        await flush(b);
        expect(chatIn(b)).toEqual([[1, ids(b)[0]]]);
    });

    it("4.4: a confirmation that comes after the user went to another chat reaches the message in its own chat", async () => {
        const b = await connected();
        const a = b.open(CHAT);
        await b.server.history(CHAT).answer([]);
        await a.read;
        await send(b, "from chat A");
        const [id] = ids(b);

        const other = b.open(OTHER);
        await b.server.history(OTHER).answer([row({id: OLD, chat: OTHER, from: PEER, to: MY, body: "in chat B"})]);
        await other.read;

        ack(b, id, S1);                                                          // the server does not name the chat
        expect(b.queue()).toEqual([]);
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([S1]);
        expect(b.screen(OTHER)?.map((m) => m.id)).toEqual([OLD]);
    });

    it("4.4: the same with no chat on the screen, and a second confirmation changes nothing", async () => {
        const b = await connected();
        await send(b, "then the chat was closed");
        const [id] = ids(b);
        b.store.dispatch(b.m.chatUi.setSelectedChatId(null));
        ack(b, id, S1);
        ack(b, id, S1, {conversationId: CHAT});
        expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([S1]);
    });

    describe("4.5: an attachment", () => {
        const ATT = "att-1";
        const attachmentRow = () => ({...row({id: S1, chat: CHAT, from: MY, to: PEER, body: ""}), payload: {kind: "attachment", body: ""}, meta: {attachmentId: ATT, fileName: "a.txt"}});

        /** The storage the file is put to: takes it, or answers with `status`, or the network fails (0). */
        function storage(status: number) {
            const puts: string[] = [];
            class Put {
                upload: {onprogress?: (e: unknown) => void} = {};
                onload: (() => void) | null = null;
                onerror: (() => void) | null = null;
                status = 0;
                withCredentials = false;
                private url = "";
                open(_method: string, url: string) { this.url = url; }
                setRequestHeader() {}
                send() {
                    puts.push(this.url);
                    this.upload.onprogress?.({lengthComputable: true, loaded: 1, total: 2});
                    this.status = status;
                    setTimeout(() => (status === 0 ? this.onerror?.() : this.onload?.()), 0);
                }
            }
            vi.stubGlobal("XMLHttpRequest", Put);
            return puts;
        }

        /** The open chat with its attachment hook; what the server says to each of the three steps. */
        async function sending(o: {url?: () => unknown; put?: number; confirm?: () => unknown} = {}) {
            const b = await connected();
            const chat = b.open(CHAT);
            await b.server.history(CHAT).answer([]);
            await chat.read;
            const done = vi.spyOn(toast, "success").mockImplementation(() => "");
            const puts = storage(o.put ?? 200);
            b.server.reply("POST", /\/attachments\/upload-url$/, o.url ?? (() => ({attachmentId: ATT, objectKey: "k", uploadUrl: "http://edge.test/put/att-1", method: "PUT", expiresAt: ""})));
            b.server.reply("POST", /\/confirm$/, o.confirm ?? (() => ({status: "ok"})));
            const {useChatAttachments} = await import("@/features/chat/hooks/useChatAttachments");
            const view = renderHook(() => useChatAttachments(CHAT, () => chat.reread()), {wrapper: b.wrapper});
            const file = new File(["text"], "a.txt", {type: "text/plain"});
            let ended = false;
            const run = act(async () => { await view.result.current.sendAttachment(file); ended = true; });
            const asked = (what: RegExp) => b.server.requests().filter((r) => r.method === "POST" && what.test(r.path)).length;
            return {b, done, puts, view, run, asked, ended: () => ended};
        }
        const lost = () => { throw new TypeError("Failed to fetch"); };

        it("4.5: the answer to the confirmation is lost, the message is in the history — no error, nothing to send again", async () => {
            const s = await sending({confirm: lost});
            await s.b.server.history(CHAT).answer([attachmentRow()]);
            await s.run;
            expect(s.b.errors()).toEqual([]);
            expect(s.done).toHaveBeenCalledTimes(1);
            expect(s.b.screen(CHAT)?.map((m) => m.id)).toEqual([S1]);
            expect(s.asked(/\/confirm$/)).toBe(1);
            expect(s.view.result.current.uploadProgress).toBeNull();
        });

        it("4.5: the confirmation is refused and the history has no such message — the error is shown", async () => {
            const s = await sending({confirm: () => new Response("{}", {status: 502})});
            await s.b.server.history(CHAT).answer([]);
            await s.run;
            expect(s.b.errors()).toHaveLength(1);
            expect(s.done).not.toHaveBeenCalled();
        });

        it("4.5: the confirmation is lost and the history cannot be read either — the error is shown", async () => {
            const s = await sending({confirm: lost});
            await s.b.server.history(CHAT).fail();
            await s.run;
            expect(s.b.errors()).toHaveLength(1);
            expect(s.done).not.toHaveBeenCalled();
        });

        it("4.5: all three steps pass — the history is read and the message is on the screen", async () => {
            const s = await sending();
            await s.b.server.history(CHAT).answer([attachmentRow()]);
            await s.run;
            expect(s.puts).toEqual(["http://edge.test/put/att-1"]);
            expect(s.b.errors()).toEqual([]);
            expect(s.done).toHaveBeenCalledTimes(1);
            expect(s.b.screen(CHAT)?.map((m) => m.meta?.attachmentId)).toEqual([ATT]);
        });

        it("4.5: the first step fails (no address to put the file to) — the error, nothing is put or confirmed", async () => {
            const s = await sending({url: () => new Response("{}", {status: 500})});
            await s.run;
            expect(s.b.errors()).toHaveLength(1);
            expect(s.puts).toEqual([]);
            expect(s.asked(/\/confirm$/)).toBe(0);
            expect(s.b.server.history(CHAT).asked()).toBe(1);                    // only the read at the opening
        });

        it.each([["the storage refuses the file", 403], ["the network fails", 0]])("4.5: the second step fails (%s) — the error, nothing is confirmed", async (_why, put) => {
            const s = await sending({put});
            await s.run;
            expect(s.b.errors()).toHaveLength(1);
            expect(s.puts).toHaveLength(1);
            expect(s.asked(/\/confirm$/)).toBe(0);
            expect(s.b.server.history(CHAT).asked()).toBe(1);
        });

        it("4.5: a file over the limit and a chat that is not open send nothing", async () => {
            const b = await connected();
            const {useChatAttachments} = await import("@/features/chat/hooks/useChatAttachments");
            const {MAX_ATTACHMENT_BYTES} = await import("@/shared/config/chat");
            const big = new File(["x"], "big.bin");
            Object.defineProperty(big, "size", {value: MAX_ATTACHMENT_BYTES + 1});
            const open = renderHook(() => useChatAttachments(CHAT, async () => {}), {wrapper: b.wrapper});
            await act(async () => { await open.result.current.sendAttachment(big); });
            expect(b.errors()).toHaveLength(1);
            const closed = renderHook(() => useChatAttachments(null, async () => {}), {wrapper: b.wrapper});
            await act(async () => { await closed.result.current.sendAttachment(new File(["x"], "a.txt")); });
            expect(b.server.requests().filter((r) => r.method === "POST")).toEqual([]);
        });
    });

    describe("a peer on an earlier build sends the same message three times", () => {
        const X = "client-id-of-the-peer";
        const copy = (id: string, at = 1_700_000_000_000) => row({id, chat: CHAT, from: PEER, to: MY, body: "hello", clientId: X, at});

        it("over the socket — one row; every copy is acknowledged", async () => {
            const b = await connected();
            const chat = b.open(CHAT);
            await b.server.history(CHAT).answer([]);
            await chat.read;
            for (const id of [S1, S2, S3]) b.socket.frame(copy(id));
            expect(b.screen(CHAT)?.map((m) => m.id)).toEqual([S1]);
            expect(b.socket.sent("CHAT_ACK")).toHaveLength(3);
        });

        it("in the history — one row, also when one copy came over the socket first", async () => {
            const b = await connected();
            const chat = b.open(CHAT);
            b.socket.frame(copy(S2));                                            // while the chat is being read
            await b.server.history(CHAT).answer([copy(S1), copy(S2), copy(S3)]);
            await chat.read;
            expect(b.screen(CHAT)).toHaveLength(1);

            const again = chat.reread();
            await b.server.history(CHAT).answer([copy(S1), copy(S2), copy(S3)]);
            await again;
            expect(b.screen(CHAT)).toHaveLength(1);
        });

        it("across two pages of the history — one row", async () => {
            const b = await connected();
            const {HISTORY_PAGE_SIZE} = await import("@/shared/config/chat");
            const page = Array.from({length: HISTORY_PAGE_SIZE - 1}, (_, i) =>
                row({id: `01ARZ3NDEKTSV4RRFFQ69G6${String(i).padStart(3, "0")}`, chat: CHAT, from: PEER, to: MY, body: `m${i}`}));
            const chat = b.open(CHAT);
            await b.server.history(CHAT).answer([copy(S3), ...page]);            // the newest page starts with the last copy
            await chat.read;
            expect(b.screen(CHAT)).toHaveLength(HISTORY_PAGE_SIZE);

            const older = b.store.dispatch(b.m.older.loadOlderHistory(CHAT)) as Promise<unknown>;
            // the older page: two more copies of it, and two copies of an earlier message
            const earlier = (id: string) => row({id, chat: CHAT, from: PEER, to: MY, body: "older", clientId: "another-client-id"});
            await b.server.history(CHAT).answer([earlier(OLD), earlier(OLD2), copy(S1), copy(S2)]);
            await older;
            const rows = b.screen(CHAT) ?? [];
            expect(rows.filter((m) => m.clientId === X)).toHaveLength(1);
            expect(rows.filter((m) => m.clientId === "another-client-id")).toHaveLength(1);
            expect(rows).toHaveLength(HISTORY_PAGE_SIZE + 1);
        });

        it("the app is told about every copy, and shows a notification for the first one only", async () => {
            const b = await bench({app: true});
            await b.signIn(MY);
            b.socket.connect();
            b.page.hide();                                                       // a chat never opened, the app is not on the screen
            for (const id of [S1, S2, S3]) b.socket.frame(copy(id));
            expect(b.app.notified().map((n) => [n.messageId, n.hidden])).toEqual([[S1, true], [S2, false], [S3, false]]);
            await b.until(() => b.socket.sent("CHAT_ACK").length === 3, "the three confirmations");   // after the app's answers
        });

        it("the same copy delivered again (its acknowledgement was lost) is not taken for another one", async () => {
            const b = await bench({app: true});
            await b.signIn(MY);
            b.socket.connect();
            b.page.hide();
            b.socket.frame(copy(S1));
            b.socket.frame(copy(S1));
            expect(b.app.notified().map((n) => [n.messageId, n.hidden])).toEqual([[S1, true], [S1, true]]);
        });
    });
});
