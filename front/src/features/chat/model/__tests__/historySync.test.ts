import {describe, it, expect, beforeEach} from "vitest";
import {forgetHistorySync, isStale, liveEpoch, markStale, noteHistoryRead} from "../historySync";

const up = (epoch: number) => ({status: "connected", epoch});
const down = (epoch: number) => ({status: "disconnected", epoch});

describe("the sign that the socket had a gap (spec 002 §3.1)", () => {
    beforeEach(() => forgetHistorySync());

    it("a chat never read is stale; read under the live connection it is complete", () => {
        expect(isStale("c1", up(1))).toBe(true);
        expect(noteHistoryRead("c1", liveEpoch(up(1)), up(1))).toBe(true);
        expect(isStale("c1", up(1))).toBe(false);
        expect(isStale("c2", up(1))).toBe(true);      // another chat is not covered
    });

    it("any gap makes every chat stale: a new connection number, whatever the reason", () => {
        noteHistoryRead("c1", 1, up(1));
        noteHistoryRead("c2", 1, up(1));
        expect(isStale("c1", down(1))).toBe(true);    // while the socket is down nothing is provable
        expect(isStale("c1", up(2))).toBe(true);
        expect(isStale("c2", up(2))).toBe(true);
    });

    it("a read that started while the socket was down proves nothing", () => {
        expect(noteHistoryRead("c1", liveEpoch(down(1)), up(2))).toBe(false);
        expect(isStale("c1", up(2))).toBe(true);
    });

    it("a read during which the connection changed proves nothing", () => {
        expect(noteHistoryRead("c1", 1, up(2))).toBe(false);
        expect(noteHistoryRead("c1", 1, down(1))).toBe(false);
        expect(isStale("c1", up(2))).toBe(true);
    });

    it("a push or a tap marks one chat stale under a live connection", () => {
        noteHistoryRead("c1", 3, up(3));
        noteHistoryRead("c2", 3, up(3));
        markStale("c1");
        expect(isStale("c1", up(3))).toBe(true);
        expect(isStale("c2", up(3))).toBe(false);
    });
});
