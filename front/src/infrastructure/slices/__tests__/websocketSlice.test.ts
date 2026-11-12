import {describe, it, expect} from "vitest";
import reducer, {connecting, connected, disconnected, superseded} from "../websocketSlice.ts";

const initial = reducer(undefined, {type: "@@INIT"});

describe("websocketSlice superseded (4409 take-over) flag", () => {
    it("starts false", () => {
        expect(initial.superseded).toBe(false);
    });

    it("superseded() flags it and marks us disconnected", () => {
        const s = reducer(initial, superseded());
        expect(s.superseded).toBe(true);
        expect(s.status).toBe("disconnected");
    });

    it("a plain disconnected() does NOT set the flag (distinct from a take-over)", () => {
        const s = reducer(initial, disconnected());
        expect(s.superseded).toBe(false);
    });

    it("connecting() clears the flag — we're reclaiming the session", () => {
        const taken = reducer(initial, superseded());
        expect(reducer(taken, connecting()).superseded).toBe(false);
    });

    it("connected() clears the flag", () => {
        const taken = reducer(initial, superseded());
        expect(reducer(taken, connected()).superseded).toBe(false);
    });
});
