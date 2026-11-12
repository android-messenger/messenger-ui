import {describe, it, expect} from "vitest";
import reducer, {setPeerLastReadId, setSelectedChatId, setTyping} from "../chatUiSlice";
import {clearUser} from "@/features/auth/slices/userSlice";

// Two real-shaped server ULIDs (26 Crockford chars); B is chronologically after A.
const ULID_A = "01KY02T0BZCR9RC8FFM2398VBC";
const ULID_B = "01KY29D4BHHB40EW2FKMHR6V7M";
const UUID = "fdeb0945-b0cb-44ac-9286-5365a96b0788";

const init = () => reducer(undefined, {type: "@@init"});

describe("chatUiSlice — peer read watermark (✓✓)", () => {
    it("sets the peer read boundary for a chat from a server ULID", () => {
        const s = reducer(init(), setPeerLastReadId({chatId: "c1", lastReadId: ULID_A}));
        expect(s.peerLastReadIdByChat.c1).toBe(ULID_A);
    });

    it("is monotonic: advances forward but never regresses", () => {
        let s = reducer(init(), setPeerLastReadId({chatId: "c1", lastReadId: ULID_B}));
        s = reducer(s, setPeerLastReadId({chatId: "c1", lastReadId: ULID_A})); // older → ignored
        expect(s.peerLastReadIdByChat.c1).toBe(ULID_B);
    });

    it("rejects a non-ULID boundary (legacy UUID) so it can never light up false ✓✓", () => {
        const s = reducer(init(), setPeerLastReadId({chatId: "c1", lastReadId: UUID}));
        expect(s.peerLastReadIdByChat.c1).toBeUndefined();
    });

    it("ignores null/empty boundaries", () => {
        let s = reducer(init(), setPeerLastReadId({chatId: "c1", lastReadId: null}));
        s = reducer(s, setPeerLastReadId({chatId: "c1", lastReadId: ""}));
        expect(s.peerLastReadIdByChat.c1).toBeUndefined();
    });

    it("keeps boundaries per-conversation (no cross-chat leakage)", () => {
        let s = reducer(init(), setPeerLastReadId({chatId: "c1", lastReadId: ULID_A}));
        s = reducer(s, setPeerLastReadId({chatId: "c2", lastReadId: ULID_B}));
        expect(s.peerLastReadIdByChat.c1).toBe(ULID_A);
        expect(s.peerLastReadIdByChat.c2).toBe(ULID_B);
    });

    it("clears all watermarks on logout (clearUser)", () => {
        let s = reducer(init(), setPeerLastReadId({chatId: "c1", lastReadId: ULID_A}));
        s = reducer(s, setSelectedChatId("c1"));
        s = reducer(s, clearUser());
        expect(s.peerLastReadIdByChat).toEqual({});
        expect(s.selectedChatId).toBeNull();
    });
});

describe("chatUiSlice — typing (group author)", () => {
    it("records the typing author id alongside the typing flag", () => {
        const s = reducer(init(), setTyping({chatId: "c1", typing: true, author: "u2"}));
        expect(s.typingByChat.c1).toBe(true);
        expect(s.typingUserByChat.c1).toBe("u2");
    });

    it("clears both the flag and the author when typing stops", () => {
        let s = reducer(init(), setTyping({chatId: "c1", typing: true, author: "u2"}));
        s = reducer(s, setTyping({chatId: "c1", typing: false}));
        expect(s.typingByChat.c1).toBe(false);
        expect(s.typingUserByChat.c1).toBeUndefined();
    });

    it("works without an author (1:1 typing) — no author recorded", () => {
        const s = reducer(init(), setTyping({chatId: "c1", typing: true}));
        expect(s.typingByChat.c1).toBe(true);
        expect(s.typingUserByChat.c1).toBeUndefined();
    });

    it("clears typing author on logout", () => {
        let s = reducer(init(), setTyping({chatId: "c1", typing: true, author: "u2"}));
        s = reducer(s, clearUser());
        expect(s.typingUserByChat).toEqual({});
    });
});
