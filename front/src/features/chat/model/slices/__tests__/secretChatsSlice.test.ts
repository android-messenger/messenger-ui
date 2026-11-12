import {describe, it, expect} from "vitest";
import reducer, {markSecret, clearSecretChats} from "../secretChatsSlice";
import * as slice from "../secretChatsSlice";

// Spec 001, story 4: a chat that became secret stays secret (owner's decision Q2).
describe("secretChatsSlice", () => {
    it("markSecret marks the chat", () => {
        expect(reducer({byId: {}}, markSecret("c1")).byId).toEqual({c1: true});
    });

    it("marking twice changes nothing", () => {
        const once = reducer({byId: {}}, markSecret("c1"));
        expect(reducer(once, markSecret("c1")).byId).toEqual({c1: true});
    });

    it("has no action that turns one chat back to normal", () => {
        expect(Object.keys(slice).sort()).toEqual(["clearSecretChats", "default", "loadSecretChats", "markSecret", "saveSecretChats"]);
        // The old toggle payload must not unmark anything if an old caller still sends it.
        const state = reducer({byId: {c1: true}}, {type: "secretChats/setSecret", payload: {conversationId: "c1", secret: false}});
        expect(state.byId).toEqual({c1: true});
    });

    it("clearSecretChats (logout) empties the set", () => {
        expect(reducer({byId: {c1: true}}, clearSecretChats()).byId).toEqual({});
    });
});
