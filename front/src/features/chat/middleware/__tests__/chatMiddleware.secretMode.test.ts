import {describe, it, expect, vi, beforeEach} from "vitest";
import {configureStore} from "@reduxjs/toolkit";

// Spec 001, story 4: an encrypted message — live, or in the history of a device that remembers nothing —
// marks the chat secret on the receiving device, so its reply goes out encrypted. Nothing from the server
// turns the mode off; the user does, at will.

const h = vi.hoisted(() => ({
    decryptReceived: vi.fn(async () => "hello"),
    loadPlaintext: vi.fn(async (): Promise<string | null> => "hello"),
    savePlaintext: vi.fn(async () => true),
}));

vi.mock("@/features/chat/rest/chatApi.ts", () => ({
    chatApi: {
        util: {updateQueryData: vi.fn((endpoint: string, args: unknown, recipe: unknown) => ({type: "test/updateQueryData", endpoint, args, recipe}))},
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
vi.mock("@/features/e2ee", () => ({
    secretCrypto: {decrypt: h.decryptReceived},
    savePlaintext: h.savePlaintext, loadPlaintext: h.loadPlaintext, E2EE_PLAINTEXT_TTL_MS: 172_800_000,
    reportUndecryptable: vi.fn(() => ({type: "e2ee/report"})),
}));

import {chatMiddleware} from "../chatMiddleware";
import secretChats, {unmarkSecret} from "@/features/chat/model/slices/secretChatsSlice";

function makeStore() {
    return configureStore({
        reducer: {
            secretChats,
            user: () => ({id: "me"}),
            chatUi: () => ({selectedChatId: "c1"}),
        },
        middleware: (getDefault) => getDefault({serializableCheck: false, immutableCheck: false}).concat(chatMiddleware),
    });
}
const isSecret = (s: ReturnType<typeof makeStore>, id: string) => !!s.getState().secretChats.byId[id];

const incoming = (body: string, conversationId = "c1") => ({
    type: "ws/incoming",
    payload: {
        type: "CHAT_OUT", messageId: "01KY29D4BHHB40EW2FKMHR6V7M", correlationId: "nano_1", conversationId,
        senderId: "peer", recipientId: "me", serverTimestamp: 1_700_000_000_000, payload: {body, kind: "text"},
    },
});

beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(document, "hidden", {configurable: true, get: () => false});
});

describe("secret mode follows the encrypted messages", () => {
    it("an encrypted message from the peer makes the chat secret on this device", () => {
        const store = makeStore();
        expect(isSecret(store, "c1")).toBe(false);
        store.dispatch(incoming("E2EE1:opaque"));
        expect(isSecret(store, "c1")).toBe(true);
    });

    it("a clear message does not make the chat secret", () => {
        const store = makeStore();
        store.dispatch(incoming("plain text"));
        expect(isSecret(store, "c1")).toBe(false);
    });

    it("a clear message in a secret chat does not turn the mode off", () => {
        const store = makeStore();
        store.dispatch(incoming("E2EE1:opaque"));
        store.dispatch(incoming("plain text from an old client"));
        expect(isSecret(store, "c1")).toBe(true);
    });

    it("the mark comes back from the history when the device has forgotten it", () => {
        const store = makeStore();   // nothing remembered: a cleared localStorage or a new install
        store.dispatch({
            type: "test/historyFulfilled",
            meta: {arg: {originalArgs: {myId: "me", chatId: "c7"}}},
            payload: [{id: "1", from: "peer", text: "old clear text"}, {id: "2", from: "peer", text: "E2EE1:opaque"}],
        });
        expect(isSecret(store, "c7")).toBe(true);
    });

    // Owner's decision 2026-11-12: the user turns the mode off at will. Only the user does.
    it("old encrypted messages in the history do not undo the user's 'off'", () => {
        const store = makeStore();
        store.dispatch(incoming("E2EE1:opaque"));
        store.dispatch(unmarkSecret("c1"));
        store.dispatch({
            type: "test/historyFulfilled",
            meta: {arg: {originalArgs: {myId: "me", chatId: "c1"}}},
            payload: [{id: "2", from: "peer", text: "E2EE1:opaque"}],
        });
        expect(isSecret(store, "c1")).toBe(false);
    });

    it("after the user's 'off' a clear message leaves the chat ordinary, a new encrypted one turns the mode on again", () => {
        const store = makeStore();
        store.dispatch(incoming("E2EE1:opaque"));
        store.dispatch(unmarkSecret("c1"));
        store.dispatch(incoming("plain text"));
        expect(isSecret(store, "c1")).toBe(false);
        store.dispatch(incoming("E2EE2:3.opaque"));   // the peer writes encrypted now: the reply must be too
        expect(isSecret(store, "c1")).toBe(true);
    });

    it("a history without encrypted messages leaves the chat ordinary", () => {
        const store = makeStore();
        store.dispatch({
            type: "test/historyFulfilled",
            meta: {arg: {originalArgs: {myId: "me", chatId: "c8"}}},
            payload: [{id: "1", from: "peer", text: "clear"}],
        });
        expect(isSecret(store, "c8")).toBe(false);
    });
});

// Spec 001, story 5, finding 46: the text is shown, but if it could not be stored the row says so.
describe("a decrypted message that could not be stored", () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const lastRow = async () => {
        const {chatApi} = await import("@/features/chat/rest/chatApi.ts");
        const row: {id: string; text: string; unsaved?: boolean} = {id: "01KY29D4BHHB40EW2FKMHR6V7M", text: "?"};
        for (const c of vi.mocked(chatApi.util.updateQueryData).mock.calls) (c[2] as unknown as (d: unknown[]) => void)([row]);
        return row;
    };

    beforeEach(async () => {
        const {chatApi} = await import("@/features/chat/rest/chatApi.ts");
        vi.mocked(chatApi.util.updateQueryData).mockClear();
        h.loadPlaintext.mockResolvedValue(null);   // not seen before → the ratchet runs
    });

    it("is marked unsaved when the save fails", async () => {
        h.savePlaintext.mockResolvedValue(false);
        makeStore().dispatch(incoming("E2EE1:opaque"));
        await flush(); await flush();
        const row = await lastRow();
        expect(row.text).toBe("hello");
        expect(row.unsaved).toBe(true);
    });

    it("is not marked when the save succeeds", async () => {
        h.savePlaintext.mockResolvedValue(true);
        makeStore().dispatch(incoming("E2EE1:opaque"));
        await flush(); await flush();
        expect((await lastRow()).unsaved).toBeUndefined();
    });
});
