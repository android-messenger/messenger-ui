import {describe, it, expect} from "vitest";
import reducer, {markSecret, unmarkSecret, clearSecretChats} from "../secretChatsSlice";
import * as slice from "../secretChatsSlice";

// Spec 001, story 4, as changed by the owner 2026-11-12: the user switches the secret mode both ways.
describe("secretChatsSlice", () => {
    it("markSecret marks the chat", () => {
        expect(reducer({byId: {}}, markSecret("c1")).byId).toEqual({c1: true});
    });

    it("marking twice changes nothing", () => {
        const once = reducer({byId: {}}, markSecret("c1"));
        expect(reducer(once, markSecret("c1")).byId).toEqual({c1: true});
    });

    it("unmarkSecret turns the mode off and remembers that the user did it; it can be turned on again", () => {
        const off = reducer({byId: {c1: true, c2: true}}, unmarkSecret("c1"));
        expect(off.byId).toEqual({c1: false, c2: true});
        expect(reducer(off, markSecret("c1")).byId).toEqual({c1: true, c2: true});
    });

    it("only the user's own action turns a chat back to normal", () => {
        expect(Object.keys(slice).sort()).toEqual(["clearSecretChats", "default", "loadSecretChats", "markSecret", "saveSecretChats", "unmarkSecret"]);
        // The old toggle payload — what a frame from the server could be shaped like — unmarks nothing.
        const state = reducer({byId: {c1: true}}, {type: "secretChats/setSecret", payload: {conversationId: "c1", secret: false}});
        expect(state.byId).toEqual({c1: true});
    });

    it("clearSecretChats (logout) empties the set", () => {
        expect(reducer({byId: {c1: true}}, clearSecretChats()).byId).toEqual({});
    });
});
