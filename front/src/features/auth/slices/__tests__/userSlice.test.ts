import {describe, it, expect} from "vitest";
import reducer, {setUser, clearUser, markInitialized} from "../userSlice";
import {anonimo} from "@/shared/utils/checks.ts";

const initial = reducer(undefined, {type: "@@INIT"});

describe("userSlice", () => {
    it("starts anonimo + uninitialized", () => {
        expect(initial).toEqual({id: anonimo, name: anonimo, initialized: false});
    });

    it("setUser sets id/name and marks initialized", () => {
        expect(reducer(initial, setUser({id: "u1", name: "Alice"})))
            .toEqual({id: "u1", name: "Alice", initialized: true});
    });

    it("clearUser resets to anonimo (still initialized)", () => {
        const logged = reducer(initial, setUser({id: "u1", name: "Alice"}));
        expect(reducer(logged, clearUser())).toEqual({id: anonimo, name: anonimo, initialized: true});
    });

    it("markInitialized only flips the flag", () => {
        expect(reducer(initial, markInitialized()).initialized).toBe(true);
    });
});
