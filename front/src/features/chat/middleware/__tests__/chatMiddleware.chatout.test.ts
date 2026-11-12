import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";

// --- Mutable test doubles (hoisted so vi.mock factories can close over them) ---
const h = vi.hoisted(() => ({
    getChatsData: [] as Array<{conversationId: string}>,
    getGroupsData: [] as Array<{id: string}>,
}));

vi.mock("@/features/chat/rest/chatApi.ts", () => ({
    chatApi: {
        // Capture (endpoint, args, recipe) so a test can invoke the draft mutator directly.
        util: {
            updateQueryData: vi.fn((endpoint, args, recipe) => ({
                type: "test/updateQueryData", endpoint, args, recipe,
            })),
        },
        endpoints: {
            getChats: {select: vi.fn(() => () => ({data: h.getChatsData}))},
        },
    },
}));

vi.mock("@/features/groups/rest/groupApi.ts", () => ({
    groupApi: {
        endpoints: {
            getGroups: {
                select: vi.fn(() => () => ({data: h.getGroupsData})),
                initiate: vi.fn(() => ({type: "test/getGroups/initiate"})),
            },
        },
    },
}));

vi.mock("@/features/chat/model/services/chatMessages.service.ts", () => ({
    chatMessagesService: {refetchChatsPreservingSelected: vi.fn()},
}));

vi.mock("@/shared/sound/notify.ts", () => ({
    playNotificationSound: vi.fn(),
}));
vi.mock("@/features/notifications/desktopNotification.ts", () => ({
    showDesktopNotification: vi.fn(),
}));

vi.mock("@/shared/i18n", () => ({default: {t: (k: string) => k}}));

import {chatMiddleware} from "../chatMiddleware";
import {chatMessagesService} from "@/features/chat/model/services/chatMessages.service.ts";
import {playNotificationSound} from "@/shared/sound/notify.ts";
import {showDesktopNotification} from "@/features/notifications/desktopNotification.ts";
import {markSent} from "@/features/chat/model/slices/outboxSlice.ts";
import {markChatUnread} from "@/features/chat/model/slices/chatUiSlice.ts";

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
    const run = (frame: unknown) =>
        chatMiddleware(store as never)(next as never)({type: "ws/incoming", payload: frame});
    return {dispatched, store, next, run};
}

const sends = (d: Dispatched[]) => d.filter((a) => a.type === "ws/send").map((a) => a.payload as Record<string, unknown>);
const recipe = (d: Dispatched[], endpoint: string) => {
    const found = d.find((a) => a.type === "test/updateQueryData" && a.endpoint === endpoint);
    return found?.recipe as ((draft: unknown[]) => void) | undefined;
};

function setHidden(v: boolean) {
    Object.defineProperty(document, "hidden", {configurable: true, get: () => v});
}

const chatOut = (over: Record<string, unknown> = {}) => ({
    type: "CHAT_OUT",
    messageId: SERVER_ID,
    correlationId: CLIENT_ID,
    conversationId: "c1",
    senderId: "peer",
    recipientId: "me",
    serverTimestamp: 1_700_000_000_000,
    payload: {body: "hi", kind: "text"},
    ...over,
});

beforeEach(() => {
    h.getChatsData = [{conversationId: "c1"}];
    h.getGroupsData = [];
    vi.mocked(chatMessagesService.refetchChatsPreservingSelected).mockClear();
    vi.mocked(playNotificationSound).mockClear();
    vi.mocked(showDesktopNotification).mockClear();
    setHidden(false);
});
afterEach(() => setHidden(false));

describe("chatMiddleware — CHAT_OUT (live delivery)", () => {
    it("appends a new message to the open history", () => {
        const {dispatched, run} = harness("c1");
        run(chatOut());
        const draft: Array<{id?: string; clientId?: string}> = [];
        recipe(dispatched, "getChatHistory")?.(draft);
        expect(draft).toHaveLength(1);
        expect(draft[0]).toMatchObject({id: SERVER_ID, clientId: CLIENT_ID, chatId: "c1", text: "hi"});
    });

    it("dedups a duplicate live delivery by server id", () => {
        const {dispatched, run} = harness("c1");
        run(chatOut());
        const draft = [{id: SERVER_ID, clientId: "other"}];
        recipe(dispatched, "getChatHistory")?.(draft);
        expect(draft).toHaveLength(1);
    });

    it("dedups a lost-ACK resend by clientId (client messageId)", () => {
        const {dispatched, run} = harness("c1");
        run(chatOut());
        const draft = [{id: "different-server-id", clientId: CLIENT_ID}];
        recipe(dispatched, "getChatHistory")?.(draft);
        expect(draft).toHaveLength(1);
    });

    it("ACKs the delivery (ws/send with correlationId = delivered messageId)", () => {
        const {dispatched, run} = harness("c1");
        run(chatOut());
        expect(sends(dispatched).some((p) => p.correlationId === SERVER_ID && p.recipientId === "peer")).toBe(true);
    });

    it("refreshes the chat list (preserve-selected) for an unknown conversation", () => {
        h.getChatsData = [{conversationId: "other"}];
        const {run} = harness("c1");
        run(chatOut());
        expect(chatMessagesService.refetchChatsPreservingSelected).toHaveBeenCalledTimes(1);
    });

    it("does NOT refresh the list when the conversation is already known", () => {
        const {run} = harness("c1");
        run(chatOut());
        expect(chatMessagesService.refetchChatsPreservingSelected).not.toHaveBeenCalled();
    });

    it("does NOT refetch the direct list for a GROUP message (the conversation is in getGroups)", () => {
        h.getChatsData = [{conversationId: "other"}];   // c1 is NOT a direct chat...
        h.getGroupsData = [{id: "c1"}];                 // ...but IS a known group
        const {run} = harness("c1");
        run(chatOut());
        expect(chatMessagesService.refetchChatsPreservingSelected).not.toHaveBeenCalled();
    });

    it("actively viewing (open + visible) → sends READ_IN to the boundary, no unread/notify", () => {
        setHidden(false);
        const {dispatched, run} = harness("c1");
        run(chatOut());
        // READ_IN carries the just-delivered server id as the read boundary.
        expect(sends(dispatched).some((p) => p.correlationId === SERVER_ID && p.recipientId === "peer" && p.type === "READ_IN")).toBe(true);
        expect(dispatched.some((a) => a.type === markChatUnread.type)).toBe(false);
        expect(playNotificationSound).not.toHaveBeenCalled();
    });

    it("hidden tab → marks unread + plays sound + shows a desktop notification", () => {
        setHidden(true);
        const {dispatched, run} = harness("c1");
        run(chatOut());
        expect(dispatched.some((a) => a.type === markChatUnread.type)).toBe(true);
        expect(playNotificationSound).toHaveBeenCalledTimes(1);
        expect(showDesktopNotification).toHaveBeenCalledWith("chat.newMessage", "hi", "c1", SERVER_ID, "peer");
    });

    it("open elsewhere but visible → unread + sound, but no desktop notification", () => {
        setHidden(false);
        const {dispatched, run} = harness("c2"); // a different chat is selected
        run(chatOut());
        expect(dispatched.some((a) => a.type === markChatUnread.type)).toBe(true);
        expect(playNotificationSound).toHaveBeenCalledTimes(1);
        expect(showDesktopNotification).not.toHaveBeenCalled();
    });
});

describe("chatMiddleware — CHAT_ACK (outbox reconcile)", () => {
    const ack = (over: Record<string, unknown> = {}) => ({
        type: "CHAT_ACK",
        correlationId: CLIENT_ID,
        conversationId: "c1",
        serverMessageId: SERVER_ID,
        serverTimestamp: 1_700_000_123_000,
        messageId: "ack-frame-own-id",
        ...over,
    });

    it("drops the accepted message from the outbox (markSent by correlationId)", () => {
        const {dispatched, run} = harness("c1");
        run(ack());
        expect(dispatched.some((a) => a.type === markSent.type && a.payload === CLIENT_ID)).toBe(true);
    });

    it("reconciles the optimistic echo: swaps temp id → server ULID and stamps server time", () => {
        const {dispatched, run} = harness("c1");
        run(ack());
        const draft = [{id: CLIENT_ID, clientId: CLIENT_ID, createdAt: new Date(0)}];
        recipe(dispatched, "getChatHistory")?.(draft);
        expect(draft[0].id).toBe(SERVER_ID);
        expect((draft[0].createdAt as Date).getTime()).toBe(1_700_000_123_000);
    });

    it("ignores a CHAT_ACK with no correlationId", () => {
        const {dispatched, run} = harness("c1");
        run(ack({correlationId: undefined}));
        expect(dispatched.some((a) => a.type === markSent.type)).toBe(false);
    });
});
