import {describe, it, expect} from "vitest";
import {chatsToProbe, inBatches, isUnread, UNREAD_PROBE_MAX_CHATS} from "../unreadProbe";
import type {ChatSummary} from "@/entities/conversation";

const A = "01HZZZZZZZZZZZZZZZZZZZZZZA", B = "01HZZZZZZZZZZZZZZZZZZZZZZB";
const chat = (id: string, kind: "direct" | "group" = "direct"): ChatSummary =>
    ({conversationId: id, kind, counterpartId: "peer", blocked: false, blockedByMe: false, blockedByPeer: false});

describe("unread from the server (spec 002 §3.2)", () => {
    it("unread: the last message is not mine and is newer than my read position", () => {
        expect(isUnread({id: B, from: "peer"}, "me", A)).toBe(true);
        expect(isUnread({id: B, from: "peer"}, "me", undefined)).toBe(true);    // never read anything
    });

    it("not unread: my own last message, a message I have read, an empty chat, a row that is not stored yet", () => {
        expect(isUnread({id: B, from: "me"}, "me", A)).toBe(false);
        expect(isUnread({id: A, from: "peer"}, "me", A)).toBe(false);
        expect(isUnread({id: A, from: "peer"}, "me", B)).toBe(false);
        expect(isUnread(undefined, "me", A)).toBe(false);
        expect(isUnread({id: "temp-client-id", from: "peer"}, "me", A)).toBe(false);
    });

    it("asks direct chats only, not the one on screen, and no more than the limit", () => {
        const many = Array.from({length: UNREAD_PROBE_MAX_CHATS + 20}, (_, i) => chat("c" + i));
        const asked = chatsToProbe([chat("g1", "group"), chat("open"), ...many], "open");
        expect(asked).toHaveLength(UNREAD_PROBE_MAX_CHATS);
        expect(asked.some((c) => c.conversationId === "open" || c.kind === "group")).toBe(false);
    });

    it("runs a few requests at a time and a failed one does not stop the rest", async () => {
        let running = 0, peak = 0;
        const done: number[] = [];
        await inBatches([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
            running++; peak = Math.max(peak, running);
            await new Promise((r) => setTimeout(r, 5));
            running--;
            if (n === 4) throw new Error("this chat failed");
            done.push(n);
        });
        expect(peak).toBe(3);
        expect(done.sort()).toEqual([1, 2, 3, 5, 6, 7]);
    });
});
