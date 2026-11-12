import {describe, it, expect} from "vitest";
import {unencryptedAfterSecret} from "../unencrypted";

// Spec 001, story 4, scenario 4: a message in the clear in a secret chat is marked.
describe("unencryptedAfterSecret", () => {
    it("flags nothing in an ordinary chat", () => {
        expect(unencryptedAfterSecret([{id: "1", text: "a"}, {id: "2", text: "b"}]).size).toBe(0);
    });

    it("does not flag the ordinary history that precedes the first encrypted message", () => {
        const flagged = unencryptedAfterSecret([{id: "1", text: "old"}, {id: "2", text: "x", secret: true}]);
        expect([...flagged]).toEqual([]);
    });

    it("flags a clear message that follows an encrypted one", () => {
        const flagged = unencryptedAfterSecret([
            {id: "1", text: "x", secret: true},
            {id: "2", text: "reply from an old client"},
            {id: "3", text: "y", secret: true},
            {id: "4", text: "photo.jpg"},
        ]);
        expect([...flagged]).toEqual(["2", "4"]);
    });

    it("counts a row still showing its envelope as encrypted", () => {
        const flagged = unencryptedAfterSecret([{id: "1", text: "E2EE1:opaque"}, {id: "2", text: "clear"}]);
        expect([...flagged]).toEqual(["2"]);
    });
});
