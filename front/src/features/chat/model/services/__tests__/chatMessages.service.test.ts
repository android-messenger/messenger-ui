import {beforeEach, describe, expect, it, vi} from "vitest";
import {chatMessagesService} from "../chatMessages.service";
import {chatApi} from "@/features/chat/rest/chatApi";
import {logger} from "@/shared/logger/logger";


vi.mock("@/store/store", () => ({}));

vi.mock("@/features/chat/rest/chatApi", () => ({
    chatApi: {
        util: {
            updateQueryData: vi.fn(),
        },
        endpoints: {
            getChatHistory: {
                initiate: vi.fn(),
            },
        },
    },
}));

vi.mock("@/features/chat/thunk/sendOutboxThunk", () => ({
    flushOutbox: vi.fn(() => ({ type: "outbox/flush-mock-thunk" })),
}));

vi.mock("@/features/chat/model/outbox", () => ({
    enqueueMessage: vi.fn((msg) => ({type: "ENQUEUE", payload: msg})),
}));

vi.mock("@/features/e2ee", () => ({
    secretCrypto: {encrypt: vi.fn(async () => "E2EE1:Y2lwaGVydGV4dA==")},
    savePlaintext: vi.fn(async () => {}),
    deletePlaintextForChat: vi.fn(async () => {}),
}));

vi.mock("@/shared/logger/logger", () => ({
    logger: {
        debug: vi.fn(),
        error: vi.fn(),
    },
}));

describe("chatMessagesService", () => {
    const dispatch = vi.fn();
    const myId = "user1";

    beforeEach(() => {
        dispatch.mockClear();
        vi.clearAllMocks();
    });

    it("clearChatHistory: deletes history and updates cache", async () => {
        const dispatch = vi.fn();
        const unwrap = vi.fn().mockResolvedValue(undefined);
        const deleteHistory = vi.fn().mockReturnValue({unwrap});

        await chatMessagesService.clearChatHistory(
            dispatch,
            deleteHistory as ReturnType<typeof chatApi.useDeleteChatHistoryMutation>[0],
            "user1",
            "chat123"
        );

        expect(deleteHistory).toHaveBeenCalledWith({
            myId: "user1",
            chatId: "chat123",
        });

        expect(unwrap).toHaveBeenCalled();

        expect(chatApi.util.updateQueryData).toHaveBeenCalledWith(
            "getChatHistory",
            {myId: "user1", chatId: "chat123"},
            expect.any(Function)
        );

        expect(dispatch).toHaveBeenCalledTimes(1);
    });


    it("clearChatHistory: does not dispatch on error", async () => {
        const dispatch = vi.fn();
        const unwrap = vi.fn().mockRejectedValue(new Error("boom"));
        const deleteHistory = vi.fn().mockReturnValue({unwrap});

        await chatMessagesService.clearChatHistory(
            dispatch,
            deleteHistory as ReturnType<typeof chatApi.useDeleteChatHistoryMutation>[0],
            "user1",
            "chat123"
        );

        expect(deleteHistory).toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
    });


    it("reloadChatHistory: does nothing if chatId is null", () => {
        const dispatch = vi.fn();

        const result = chatMessagesService.reloadChatHistory(dispatch, "user1", null);

        expect(result).toBeUndefined();
        expect(dispatch).not.toHaveBeenCalled();
    });

    it("reloadChatHistory calls initiate with correct params and dispatches it", () => {
        const dispatch = vi.fn();
        const thunk = vi.fn();

        //@ts-expect-error("no need to use types")
        chatApi.endpoints.getChatHistory.initiate.mockReturnValue(thunk);

        chatMessagesService.reloadChatHistory(dispatch, "user1", "chat123");

        // проверяем, с какими аргументами был вызван initiate
        expect(chatApi.endpoints.getChatHistory.initiate).toHaveBeenCalledWith(
            {myId: "user1", chatId: "chat123"},
            {forceRefetch: true}
        );

        expect(dispatch).toHaveBeenCalledWith(thunk);
    });

    it("reloadChatHistory does nothing if chatId is null", () => {
        const dispatch = vi.fn();

        chatMessagesService.reloadChatHistory(dispatch, "user1", null);

        expect(chatApi.endpoints.getChatHistory.initiate).not.toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
    });

    it("does nothing if conversationId is null", () => {
        chatMessagesService.enqueueChatMessage(dispatch, "Hello", myId, null, "recipient1");

        expect(dispatch).not.toHaveBeenCalled();
        expect(logger.debug).not.toHaveBeenCalled();
    });

    it("dispatches enqueueMessage and flushOutbox with correct args", () => {
        const selectedChatId = "chat123";
        const recipientId = "recipient1";
        const text = "Hello world";

        chatMessagesService.enqueueChatMessage(dispatch, text, myId, selectedChatId, recipientId);

        // The typed text never goes to the logger (it may be a secret chat's plaintext).
        expect(logger.debug).toHaveBeenCalledWith("sending chat message via a queue");
        expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain(text);

        // First dispatch is the outbox enqueue; its payload carries the CHAT_IN wire frame.
        const firstCall = dispatch.mock.calls[0][0];
        expect(firstCall.type).toBe("outbox/enqueueMessage");
        expect(firstCall.payload).toMatchObject({
            status: "pending",
            payload: {
                type: "CHAT_IN",
                conversationId: selectedChatId,
                recipientId,
                payload: { kind: "text", body: text },
            },
        });

        expect(typeof firstCall.payload.id).toBe("string");
        expect(typeof firstCall.payload.idempotencyKey).toBe("string");

        // Last dispatch flushes the outbox (the optimistic getChatHistory patch sits in between).
        const calls = dispatch.mock.calls;
        expect(calls[calls.length - 1][0].type).toBe("outbox/flush-mock-thunk");
    });

    it("secret send: the echo keeps the typed text in memory WITH secret === true, the wire and the log don't have it", async () => {
        const text = "meet at the old bridge at nine";
        await chatMessagesService.enqueueChatMessage(dispatch, text, myId, "chat-secret", "recipient1", undefined, true);

        // The optimistic echo recipe, applied to a not-yet-loaded history.
        const call = vi.mocked(chatApi.util.updateQueryData).mock.calls.find((c) => c[0] === "getChatHistory");
        const echo = (call?.[2] as unknown as (d: unknown) => Array<{text: string; secret?: boolean}>)(undefined);
        expect(echo[0].text).toBe(text);
        expect(echo[0].secret).toBe(true);

        const enqueued = dispatch.mock.calls[0][0];
        expect(enqueued.payload.payload.payload.body).toBe("E2EE1:Y2lwaGVydGV4dA==");
        expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain(text);
    });

    it("secret chat without a recipient: nothing is sent, not even in the clear", async () => {
        await chatMessagesService.enqueueChatMessage(dispatch, "must stay private", myId, "chat-secret-norcpt", "", undefined, true);
        expect(dispatch).not.toHaveBeenCalled();
    });

    it("secret chat, encryption fails: nothing is sent, not even in the clear", async () => {
        const e2ee = await import("@/features/e2ee");
        vi.mocked(e2ee.secretCrypto.encrypt).mockRejectedValueOnce(new Error("NO_PEER_KEYS"));
        await chatMessagesService.enqueueChatMessage(dispatch, "must stay private too", myId, "chat-secret-fail", "recipient1", undefined, true);
        expect(dispatch).not.toHaveBeenCalled();
    });

    it("a suppressed duplicate send does not log the text either", () => {
        const text = "double tap text";
        chatMessagesService.enqueueChatMessage(dispatch, text, myId, "chat-dup", "recipient1");
        chatMessagesService.enqueueChatMessage(dispatch, text, myId, "chat-dup", "recipient1");
        expect(logger.debug).toHaveBeenCalledWith("duplicate send suppressed (idempotency window)");
        expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain(text);
    });
});
