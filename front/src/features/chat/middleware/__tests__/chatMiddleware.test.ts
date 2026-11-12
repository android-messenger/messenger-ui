import {describe, it, expect, vi, beforeEach} from "vitest";
import {chatMiddleware} from "../chatMiddleware";
import {setPeerLastReadId, setTyping} from "@/features/chat/model/slices/chatUiSlice";
import {chatApi} from "@/features/chat/rest/chatApi";

const ULID = "01KY29D4BHHB40EW2FKMHR6V7M";

describe("chatMiddleware — READ_OUT (live ✓✓ watermark)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let store: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let next: any;

    beforeEach(() => {
        store = {
            dispatch: vi.fn(),
            getState: vi.fn(() => ({user: {id: "me"}, chatUi: {selectedChatId: "c1"}})),
        };
        next = vi.fn();
    });

    it("advances the peer read boundary from READ_OUT.correlationId (a server ULID)", () => {
        const frame = {type: "READ_OUT", conversationId: "c1", correlationId: ULID};
        chatMiddleware(store)(next)({type: "ws/incoming", payload: frame});
        expect(store.dispatch).toHaveBeenCalledWith(setPeerLastReadId({chatId: "c1", lastReadId: ULID}));
        expect(next).toHaveBeenCalled();
    });

    it("ignores a READ_OUT with no boundary (correlationId absent)", () => {
        const frame = {type: "READ_OUT", conversationId: "c1"};
        chatMiddleware(store)(next)({type: "ws/incoming", payload: frame});
        expect(store.dispatch).not.toHaveBeenCalledWith(
            expect.objectContaining({type: setPeerLastReadId.type})
        );
    });

    it("passes non-ws actions through untouched", () => {
        const action = {type: "some/action"};
        chatMiddleware(store)(next)(action);
        expect(next).toHaveBeenCalledWith(action);
    });
});

describe("chatMiddleware — group roster & typing", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let store: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let next: any;
    beforeEach(() => {
        store = {dispatch: vi.fn(), getState: vi.fn(() => ({user: {id: "me"}, chatUi: {selectedChatId: "c1"}}))};
        next = vi.fn();
    });

    it("SERVICE_OUT member_joined invalidates that group's roster", () => {
        const frame = {type: "SERVICE_OUT", conversationId: "g1", payload: {kind: "member_joined", body: "u3"}};
        chatMiddleware(store)(next)({type: "ws/incoming", payload: frame});
        expect(store.dispatch).toHaveBeenCalledWith(
            chatApi.util.invalidateTags([{type: "Chat", id: "group-members:g1"}])
        );
    });

    it("SERVICE_OUT with an unrelated kind does NOT invalidate the roster", () => {
        const frame = {type: "SERVICE_OUT", conversationId: "g1", payload: {kind: "something_else"}};
        chatMiddleware(store)(next)({type: "ws/incoming", payload: frame});
        expect(store.dispatch).not.toHaveBeenCalledWith(
            chatApi.util.invalidateTags([{type: "Chat", id: "group-members:g1"}])
        );
    });

    it("member_joined where I am the subject refetches my groups list (I was just added)", () => {
        // getState().user.id === "me". A getGroups refetch is dispatched as a thunk (a function).
        const frame = {type: "SERVICE_OUT", conversationId: "g1", payload: {kind: "member_joined", body: "me"}};
        chatMiddleware(store)(next)({type: "ws/incoming", payload: frame});
        expect(store.dispatch).toHaveBeenCalledWith(expect.any(Function));
    });

    it("member_joined for SOMEONE ELSE does not refetch my groups list", () => {
        const frame = {type: "SERVICE_OUT", conversationId: "g1", payload: {kind: "member_joined", body: "u3"}};
        chatMiddleware(store)(next)({type: "ws/incoming", payload: frame});
        expect(store.dispatch).not.toHaveBeenCalledWith(expect.any(Function));
    });

    it("TYPING_OUT carries the author id into setTyping (group '<name> is typing')", () => {
        const frame = {type: "TYPING_OUT", conversationId: "g1", senderId: "u2"};
        chatMiddleware(store)(next)({type: "ws/incoming", payload: frame});
        expect(store.dispatch).toHaveBeenCalledWith(setTyping({chatId: "g1", typing: true, author: "u2"}));
    });
});
