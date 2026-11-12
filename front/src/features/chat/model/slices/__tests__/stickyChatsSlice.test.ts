import {describe, it, expect, beforeEach} from "vitest";
import reducer, {rememberSticky, forgetSticky} from "../stickyChatsSlice";
import {clearUser} from "@/features/auth/slices/userSlice";
import type {ChatSummary} from "@/entities/conversation";

const direct = (id: string): ChatSummary => ({
    conversationId: id, kind: "direct", counterpartId: "peer-" + id,
    blocked: false, blockedByMe: false, blockedByPeer: false,
});
const group = (id: string): ChatSummary => ({
    conversationId: id, kind: "group", counterpartId: "", name: "G",
    blocked: false, blockedByMe: false, blockedByPeer: false,
});

beforeEach(() => localStorage.clear());
const init = () => reducer(undefined, {type: "@@init"});

describe("stickyChatsSlice", () => {
    it("remembers a DIRECT chat by conversationId", () => {
        const s = reducer(init(), rememberSticky(direct("c1")));
        expect(s.byId.c1).toMatchObject({conversationId: "c1", kind: "direct"});
    });

    it("ignores a GROUP (groups are listed from /api/groups regardless of activity)", () => {
        const s = reducer(init(), rememberSticky(group("g1")));
        expect(s.byId.g1).toBeUndefined();
    });

    it("ignores null/undefined", () => {
        const s = reducer(init(), rememberSticky(null));
        expect(Object.keys(s.byId)).toHaveLength(0);
    });

    it("forgets a chat (explicit delete)", () => {
        let s = reducer(init(), rememberSticky(direct("c1")));
        s = reducer(s, forgetSticky("c1"));
        expect(s.byId.c1).toBeUndefined();
    });

    it("clears everything on logout", () => {
        let s = reducer(init(), rememberSticky(direct("c1")));
        s = reducer(s, clearUser());
        expect(s.byId).toEqual({});
    });
});
