import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";

// The SECRET (E2EE) live-delivery path of chatMiddleware: durable dedup by server id / client id, and the
// classify-then-recover behavior added for reviewer #2 — a recoverable gap on the live path now goes to
// client-to-client recovery immediately (was: dead-ended at "unavailable" until a later history reload).

const h = vi.hoisted(() => ({
    decryptReceived: vi.fn(),
    loadPlaintext: vi.fn(),
    savePlaintext: vi.fn(),
    reportUndecryptable: vi.fn((payload: unknown) => ({type: "e2ee/reportUndecryptable", payload})),
}));

vi.mock("@/features/chat/rest/chatApi.ts", () => ({
    chatApi: {
        util: {updateQueryData: vi.fn((endpoint, args, recipe) => ({type: "test/updateQueryData", endpoint, args, recipe}))},
        endpoints: {
            getChats: {select: vi.fn(() => () => ({data: [{conversationId: "c1"}]}))},
            getChatHistory: {matchFulfilled: (a: {type?: string}) => a?.type === "test/historyFulfilled"},
        },
    },
}));
vi.mock("@/features/groups/rest/groupApi.ts", () => ({
    groupApi: {endpoints: {getGroups: {select: vi.fn(() => () => ({data: []})), initiate: vi.fn(() => ({type: "x"}))}}},
}));
vi.mock("@/features/chat/model/services/chatMessages.service.ts", () => ({chatMessagesService: {refetchChatsPreservingSelected: vi.fn()}}));
vi.mock("@/shared/sound/notify.ts", () => ({playNotificationSound: vi.fn()}));
vi.mock("@/features/notifications/desktopNotification.ts", () => ({showDesktopNotification: vi.fn()}));
vi.mock("@/shared/i18n", () => ({default: {t: (k: string) => k}}));

// The seam: real marker logic for isSecretEnvelope, mocked ratchet behind secretCrypto.decrypt.
vi.mock("@/features/e2ee", () => ({
    secretCrypto: {decrypt: h.decryptReceived},
    savePlaintext: h.savePlaintext, loadPlaintext: h.loadPlaintext, E2EE_PLAINTEXT_TTL_MS: 172_800_000,
    reportUndecryptable: h.reportUndecryptable,
}));
// wire.ts (the marker, failure.ts) is the REAL module (pure) — the classify/recoverable logic under test.

import {chatMiddleware} from "../chatMiddleware";

const SERVER_ID = "01KY29D4BHHB40EW2FKMHR6V7M";
const CLIENT_ID = "nano_abc123";
type Dispatched = {type: string; [k: string]: unknown};

function harness(selectedChatId: string | null) {
    const dispatched: Dispatched[] = [];
    const store = {
        dispatch: vi.fn((a: Dispatched) => { dispatched.push(a); return a; }),
        getState: vi.fn(() => ({user: {id: "me"}, chatUi: {selectedChatId}})),
    };
    const next = vi.fn((a) => a);
    const run = (frame: unknown) => chatMiddleware(store as never)(next as never)({type: "ws/incoming", payload: frame});
    return {dispatched, run};
}
const flush = () => new Promise((r) => setTimeout(r, 0));
// Apply the LAST getChatHistory recipe to a one-row draft → the text the path settled on.
const settledText = (d: Dispatched[]) => {
    const recipes = d.filter((a) => a.type === "test/updateQueryData" && a.endpoint === "getChatHistory");
    const draft = [{id: SERVER_ID, text: "?"}];
    for (const r of recipes) (r.recipe as (x: unknown[]) => void)(draft);
    return draft[0].text;
};

const secretOut = (over: Record<string, unknown> = {}) => ({
    type: "CHAT_OUT", messageId: SERVER_ID, correlationId: CLIENT_ID, conversationId: "c1",
    senderId: "peer", recipientId: "me", serverTimestamp: 1_700_000_000_000,
    payload: {body: "E2EE1:opaque", kind: "text"}, ...over,
});

beforeEach(() => {
    Object.defineProperty(document, "hidden", {configurable: true, get: () => false});
    h.decryptReceived.mockReset(); h.loadPlaintext.mockReset(); h.savePlaintext.mockReset(); h.reportUndecryptable.mockClear();
    h.loadPlaintext.mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe("chatMiddleware — secret live path", () => {
    it("decrypts and stashes under BOTH server id and client id (so a resend dedups)", async () => {
        h.decryptReceived.mockResolvedValue("hola");
        const {dispatched, run} = harness("c1");
        run(secretOut());
        await flush();
        expect(settledText(dispatched)).toBe("hola");
        expect(h.savePlaintext).toHaveBeenCalledWith(SERVER_ID, "c1", "hola");
        expect(h.savePlaintext).toHaveBeenCalledWith(CLIENT_ID, "c1", "hola");
    });

    it("the row that receives the decrypted text carries secret === true (keeps it out of the disk cache)", async () => {
        h.decryptReceived.mockResolvedValue("hola");
        const {dispatched, run} = harness("c1");
        run(secretOut());
        await flush();
        // Apply every getChatHistory recipe to an EMPTY loaded history: insert the row, then patch its text.
        const draft: Array<{id: string; text: string; secret?: boolean}> = [];
        for (const a of dispatched) {
            if (a.type === "test/updateQueryData" && a.endpoint === "getChatHistory") (a.recipe as (x: unknown[]) => void)(draft);
        }
        expect(draft).toHaveLength(1);
        expect(draft[0].text).toBe("hola");
        expect(draft[0].secret).toBe(true);
    });

    it("durable dedup: a stored copy is reused and the ratchet is never touched", async () => {
        h.loadPlaintext.mockResolvedValueOnce("from-at-rest");   // first check (by server id) hits
        const {dispatched, run} = harness("c1");
        run(secretOut());
        await flush();
        expect(settledText(dispatched)).toBe("from-at-rest");
        expect(h.decryptReceived).not.toHaveBeenCalled();        // one-shot ratchet protected
    });

    it("recoverable gap → shows 'pending' AND triggers client-to-client recovery", async () => {
        h.decryptReceived.mockRejectedValue(new Error("Over 2000 messages into the future!"));
        const {dispatched, run} = harness("c1");
        run(secretOut());
        await flush();
        expect(settledText(dispatched)).toBe("chat.decryptPending");
        expect(h.reportUndecryptable).toHaveBeenCalledWith({
            chatId: "c1", peerId: "peer", items: [{clientId: CLIENT_ID, serverId: SERVER_ID}],
        });
    });

    it("wrong-device (mis-addressed) → emits a metadata-only rekey hint to the sender AND recovers", async () => {
        h.decryptReceived.mockRejectedValue(new Error("e2ee: envelope has no ciphertext for this device"));
        const {dispatched, run} = harness("c1");
        run(secretOut());
        await flush();
        const hint = dispatched.find((a) => a.type === "ws/send" && (a.payload as {type?: string})?.type === "e2ee:rekey");
        expect(hint, "a rekey hint should be sent").toBeTruthy();
        expect(hint!.payload).toEqual({type: "e2ee:rekey", to: "peer", conversationId: "c1"}); // no key material
        // The mis-addressed message itself is still routed to recovery (wrong-device is recoverable).
        expect(settledText(dispatched)).toBe("chat.decryptPending");
        expect(h.reportUndecryptable).toHaveBeenCalled();
    });

    it("corrupt frame → 'unavailable', no recovery request", async () => {
        h.decryptReceived.mockRejectedValue(new Error("e2ee: not an envelope"));
        const {dispatched, run} = harness("c1");
        run(secretOut());
        await flush();
        expect(settledText(dispatched)).toBe("chat.decryptUnavailable");
        expect(h.reportUndecryptable).not.toHaveBeenCalled();
    });

    it("no clientId to correlate → 'unavailable', no recovery request", async () => {
        h.decryptReceived.mockRejectedValue(new Error("Over 2000 messages into the future!"));
        const {dispatched, run} = harness("c1");
        run(secretOut({correlationId: undefined}));
        await flush();
        expect(settledText(dispatched)).toBe("chat.decryptUnavailable");
        expect(h.reportUndecryptable).not.toHaveBeenCalled();
    });
});

// The HISTORY path: rows loaded over REST carry envelopes; each one gets its text (stored, decrypted now,
// or a state placeholder) patched in — always together with secret === true, which keeps it off disk.
describe("chatMiddleware — secret history path", () => {
    const OWN_ID = "01KY29D4BHHB40EW2FKMHR6V7N";
    function loadHistory(rows: Array<{id: string; from: string; text: string}>) {
        const dispatched: Dispatched[] = [];
        const store = {
            dispatch: vi.fn((a: Dispatched) => { dispatched.push(a); return a; }),
            getState: vi.fn(() => ({user: {id: "me"}, chatUi: {selectedChatId: "c1"}})),
        };
        chatMiddleware(store as never)(((a: unknown) => a) as never)({
            type: "test/historyFulfilled", payload: rows, meta: {arg: {originalArgs: {myId: "me", chatId: "c1"}}},
        });
        return dispatched;
    }

    it("every patched row — decrypted, restored from the store, or a placeholder — is flagged secret", async () => {
        const realNow = Date.now;
        vi.spyOn(Date, "now").mockReturnValue(1_784_000_000_000);   // close to the test ULIDs' time → not "expired"
        h.decryptReceived.mockResolvedValue("decrypted now");
        const rows = [
            {id: SERVER_ID, from: "peer", text: "E2EE1:opaque"},   // incoming, never decrypted live
            {id: OWN_ID, from: "me", text: "E2EE1:opaque"},        // own, no stored copy → placeholder
        ];
        const dispatched = loadHistory(rows);
        await flush(); await flush();
        Date.now = realNow;

        const draft: Array<{id: string; text: string; secret?: boolean}> = rows.map((r) => ({...r}));
        for (const a of dispatched) {
            if (a.type === "test/updateQueryData" && a.endpoint === "getChatHistory") (a.recipe as (x: unknown[]) => void)(draft);
        }
        expect(draft.every((r) => r.secret === true)).toBe(true);
        expect(draft.every((r) => !r.text.startsWith("E2EE1:"))).toBe(true);
    });
});
