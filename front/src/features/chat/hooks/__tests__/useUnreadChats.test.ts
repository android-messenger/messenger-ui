import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import chatUiReducer from "@/features/chat/model/slices/chatUiSlice";
import { useUnreadChats } from "../useUnreadChats";

// Unread state now lives in the chatUi slice, so the hook needs a store Provider.
function makeWrapper() {
    const store = configureStore({ reducer: { chatUi: chatUiReducer } });
    const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(Provider, { store, children });
    return { wrapper };
}

describe("useUnreadChats", () => {
    it("initially has no unread chats", () => {
        const { wrapper } = makeWrapper();
        const { result } = renderHook(() => useUnreadChats(), { wrapper });

        expect(result.current.unreadChats.size).toBe(0);
    });

    it("marks chat as unread", () => {
        const { wrapper } = makeWrapper();
        const { result } = renderHook(() => useUnreadChats(), { wrapper });

        act(() => {
            result.current.markUnread("chat1");
        });

        expect(result.current.unreadChats.has("chat1")).toBe(true);
    });

    it("does not duplicate unread chats", () => {
        const { wrapper } = makeWrapper();
        const { result } = renderHook(() => useUnreadChats(), { wrapper });

        act(() => {
            result.current.markUnread("chat1");
            result.current.markUnread("chat1");
        });

        expect(result.current.unreadChats.size).toBe(1);
    });

    it("marks chat as read", () => {
        const { wrapper } = makeWrapper();
        const { result } = renderHook(() => useUnreadChats(), { wrapper });

        act(() => {
            result.current.markUnread("chat1");
            result.current.markRead("chat1");
        });

        expect(result.current.unreadChats.has("chat1")).toBe(false);
    });

    it("markRead does nothing if chat was not unread", () => {
        const { wrapper } = makeWrapper();
        const { result } = renderHook(() => useUnreadChats(), { wrapper });

        act(() => {
            result.current.markRead("chat1");
        });

        expect(result.current.unreadChats.size).toBe(0);
    });
});
