import {describe, it, expect, vi, beforeEach} from "vitest";
import {renderHook, act} from "@testing-library/react";

const h = vi.hoisted(() => ({block: vi.fn(), unblock: vi.fn(), del: vi.fn()}));

vi.mock("@/features/chat/rest/chatApi.ts", () => ({
    useBlockChatMutation: () => [h.block],
    useUnblockChatMutation: () => [h.unblock],
    useDeleteMessageMutation: () => [h.del],
}));
vi.mock("react-i18next", () => ({useTranslation: () => ({t: (k: string) => k})}));
vi.mock("react-hot-toast", () => ({default: {success: vi.fn(), error: vi.fn()}}));

import {useChatModeration} from "../useChatModeration";
import toast from "react-hot-toast";

const ULID = "01KY29D4BHHB40EW2FKMHR6V7M";
const ok = () => ({unwrap: () => Promise.resolve()});
const fail = (status?: number) => ({unwrap: () => Promise.reject(status ? {status} : new Error("x"))});

const summaries: Record<string, {blocked?: boolean; blockedByMe?: boolean; blockedByPeer?: boolean}> = {};
const getSummary = (id: string) => summaries[id];

beforeEach(() => {
    h.block.mockReset().mockReturnValue(ok());
    h.unblock.mockReset().mockReturnValue(ok());
    h.del.mockReset().mockReturnValue(ok());
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    for (const k of Object.keys(summaries)) delete summaries[k];
});

describe("useChatModeration", () => {
    it("derives the block flags from the summary", () => {
        summaries["c1"] = {blocked: true, blockedByMe: true, blockedByPeer: false};
        const {result} = renderHook(() => useChatModeration({selectedChatId: "c1", getSummary}));
        expect(result.current.selectedBlocked).toBe(true);
        expect(result.current.selectedBlockedByMe).toBe(true);
        expect(result.current.selectedBlockedByPeer).toBe(false);
    });

    it("toggleBlock blocks when not blocked by me", async () => {
        summaries["c1"] = {blockedByMe: false};
        const {result} = renderHook(() => useChatModeration({selectedChatId: "c1", getSummary}));
        await act(async () => { await result.current.toggleBlock(); });
        expect(h.block).toHaveBeenCalledWith({chatId: "c1"});
        expect(h.unblock).not.toHaveBeenCalled();
        expect(toast.success).toHaveBeenCalledWith("chat.blocked");
    });

    it("toggleBlock unblocks when already blocked by me", async () => {
        summaries["c1"] = {blockedByMe: true};
        const {result} = renderHook(() => useChatModeration({selectedChatId: "c1", getSummary}));
        await act(async () => { await result.current.toggleBlock(); });
        expect(h.unblock).toHaveBeenCalledWith({chatId: "c1"});
        expect(h.block).not.toHaveBeenCalled();
        expect(toast.success).toHaveBeenCalledWith("chat.unblocked");
    });

    it("toggleBlock surfaces an error toast on failure", async () => {
        summaries["c1"] = {blockedByMe: false};
        h.block.mockReturnValue(fail());
        const {result} = renderHook(() => useChatModeration({selectedChatId: "c1", getSummary}));
        await act(async () => { await result.current.toggleBlock(); });
        expect(toast.error).toHaveBeenCalledWith("chat.blockError");
    });

    it("deleteMessage sends a ULID as backendId (server id)", async () => {
        const {result} = renderHook(() => useChatModeration({selectedChatId: "c1", getSummary}));
        await act(async () => { await result.current.deleteMessage(ULID); });
        expect(h.del).toHaveBeenCalledWith({chatId: "c1", backendId: ULID, clientMessageId: undefined});
    });

    it("deleteMessage sends a non-ULID as clientMessageId (temp id)", async () => {
        const {result} = renderHook(() => useChatModeration({selectedChatId: "c1", getSummary}));
        await act(async () => { await result.current.deleteMessage("temp-nanoid"); });
        expect(h.del).toHaveBeenCalledWith({chatId: "c1", backendId: undefined, clientMessageId: "temp-nanoid"});
    });

    it("deleteMessage shows the frozen-message toast on 409", async () => {
        h.del.mockReturnValue(fail(409));
        const {result} = renderHook(() => useChatModeration({selectedChatId: "c1", getSummary}));
        await act(async () => { await result.current.deleteMessage(ULID); });
        expect(toast.error).toHaveBeenCalledWith("chat.msgFrozen");
    });

    it("no-ops when no chat is selected", async () => {
        const {result} = renderHook(() => useChatModeration({selectedChatId: null, getSummary}));
        await act(async () => { await result.current.toggleBlock(); await result.current.deleteMessage(ULID); });
        expect(h.block).not.toHaveBeenCalled();
        expect(h.del).not.toHaveBeenCalled();
    });
});
