// @vitest-environment node
import "fake-indexeddb/auto";
import {describe, it, expect} from "vitest";
import {addPending, allPending, bumpAttempt, removePending} from "../pendingStore";
import {buildRequest, MAX_RECOVER_BATCH, RECOVER_REQ} from "../protocol";

describe("recovery pending store", () => {
    it("adds items, dedups by clientId, and returns only the newly added", async () => {
        const first = await addPending([{clientId: "c1", serverId: "s1", chatId: "chat", peerId: "bob"}]);
        expect(first.map((p) => p.clientId)).toEqual(["c1"]);
        const second = await addPending([
            {clientId: "c1", serverId: "s1", chatId: "chat", peerId: "bob"},   // dup → skipped
            {clientId: "c2", serverId: "s2", chatId: "chat", peerId: "bob"},
        ]);
        expect(second.map((p) => p.clientId)).toEqual(["c2"]);                 // only the new one
        expect((await allPending()).length).toBe(2);
    });

    it("bumpAttempt increments attempts + lastAt; removePending drops it", async () => {
        await addPending([{clientId: "x", serverId: "sx", chatId: "chat", peerId: "bob"}]);
        await bumpAttempt("x");
        await bumpAttempt("x");
        const rec = (await allPending()).find((p) => p.clientId === "x")!;
        expect(rec.attempts).toBe(2);
        expect(rec.lastAt).toBeGreaterThan(0);
        await removePending("x");
        expect((await allPending()).some((p) => p.clientId === "x")).toBe(false);
    });
});

describe("recovery request framing", () => {
    it("caps a request at MAX_RECOVER_BATCH (anti-storm)", () => {
        const ids = Array.from({length: MAX_RECOVER_BATCH + 25}, (_, i) => "id" + i);
        const req = buildRequest("bob", "chat", ids);
        expect(req.type).toBe(RECOVER_REQ);
        expect(req.to).toBe("bob");
        expect(req.conversationId).toBe("chat");
        expect(req.clientIds.length).toBe(MAX_RECOVER_BATCH);
    });
});
