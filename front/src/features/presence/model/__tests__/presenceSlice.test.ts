import {describe, it, expect} from "vitest";
import reducer, {presenceInit, presenceJoin, presenceLeave} from "../presenceSlice";
import {clearUser} from "@/features/auth/slices/userSlice.ts";

const initial = reducer(undefined, {type: "@@INIT"});

describe("presenceSlice", () => {
    it("presenceInit takes an authoritative snapshot and cleans up ghosts (online→offline when absent)", () => {
        let s = reducer(initial, presenceJoin({id: "a", name: "A"})); // a is online
        s = reducer(s, presenceInit([{id: "b", name: "B"}]));         // snapshot lists b, NOT a
        expect(s.byId.b.online).toBe(true);
        expect(s.byId.a.online).toBe(false); // ghost cleaned — no longer a stale "online"
    });

    it("presenceJoin marks a peer online", () => {
        const s = reducer(initial, presenceJoin({id: "a", name: "A"}));
        expect(s.byId.a).toMatchObject({id: "a", name: "A", online: true});
    });

    it("presenceLeave sets offline but keeps the known name/email", () => {
        let s = reducer(initial, presenceJoin({id: "a", name: "A", email: "a@x"}));
        s = reducer(s, presenceLeave({id: "a"})); // leave payload carries only the id
        expect(s.byId.a.online).toBe(false);
        expect(s.byId.a.name).toBe("A");
        expect(s.byId.a.email).toBe("a@x");
    });

    it("clearUser empties the presence directory", () => {
        const s = reducer(reducer(initial, presenceJoin({id: "a"})), clearUser());
        expect(s.byId).toEqual({});
    });
});
