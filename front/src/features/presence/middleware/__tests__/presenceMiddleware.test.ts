import {describe, it, expect, vi, beforeEach} from "vitest";
import {presenceMiddleware} from "../presenceMiddleware";
import {presenceInit, presenceJoin, presenceLeave} from "@/features/presence/model/presenceSlice";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let store: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let next: any;

const incoming = (type: string, body?: unknown) => ({
    type: "ws/incoming",
    payload: {type, payload: body === undefined ? {} : {body: JSON.stringify(body)}},
});

beforeEach(() => {
    store = {dispatch: vi.fn(), getState: vi.fn()};
    next = vi.fn((a) => a);
});

describe("presenceMiddleware", () => {
    it("PRESENT_INIT → presenceInit with the decoded array", () => {
        const list = [{id: "u1", name: "A"}, {id: "u2"}];
        presenceMiddleware(store)(next)(incoming("PRESENT_INIT", list));
        expect(store.dispatch).toHaveBeenCalledWith(presenceInit(list));
    });

    it("PRESENT_JOIN → presenceJoin with the decoded client", () => {
        presenceMiddleware(store)(next)(incoming("PRESENT_JOIN", {id: "u3", name: "B"}));
        expect(store.dispatch).toHaveBeenCalledWith(presenceJoin({id: "u3", name: "B"}));
    });

    it("PRESENT_LEAVE → presenceLeave with the decoded client", () => {
        presenceMiddleware(store)(next)(incoming("PRESENT_LEAVE", {id: "u4"}));
        expect(store.dispatch).toHaveBeenCalledWith(presenceLeave({id: "u4"}));
    });

    it("ignores a PRESENT_INIT whose body is not an array", () => {
        presenceMiddleware(store)(next)(incoming("PRESENT_INIT", {not: "array"}));
        expect(store.dispatch).not.toHaveBeenCalled();
    });

    it("ignores a frame with a missing / malformed body", () => {
        presenceMiddleware(store)(next)(incoming("PRESENT_JOIN")); // no body
        const bad = {type: "ws/incoming", payload: {type: "PRESENT_JOIN", payload: {body: "{not json"}}};
        presenceMiddleware(store)(next)(bad);
        expect(store.dispatch).not.toHaveBeenCalled();
    });

    it("ignores non-presence and non-ws/incoming actions, and always calls next", () => {
        presenceMiddleware(store)(next)(incoming("CHAT_OUT", {id: "x"}));
        presenceMiddleware(store)(next)({type: "some/other", payload: {}});
        expect(store.dispatch).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledTimes(2);
    });

    it("returns next(action)'s result", () => {
        next = vi.fn(() => "RESULT");
        expect(presenceMiddleware(store)(next)({type: "x"})).toBe("RESULT");
    });
});
