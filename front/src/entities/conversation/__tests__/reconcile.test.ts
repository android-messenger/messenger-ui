import {describe, it, expect} from "vitest";
import {toChatSummary, type RawConversation} from "../reconcile.ts";

const direct = (over: Partial<RawConversation> = {}): RawConversation => ({
    id: "c1", clientId: "client", masterId: "master", metadata: {}, ...over,
});

describe("toChatSummary — DIRECT", () => {
    it("maps the counterpart relative to the caller (as client → peer is master)", () => {
        const s = toChatSummary(direct(), "client");
        expect(s.kind).toBe("direct");
        expect(s.counterpartId).toBe("master");
    });

    it("maps the counterpart the other way (as master → peer is client)", () => {
        expect(toChatSummary(direct(), "master").counterpartId).toBe("client");
    });

    it("resolves block flags relative to the caller", () => {
        const c = direct({clientBlocked: true, masterBlocked: false});
        const asClient = toChatSummary(c, "client");
        expect(asClient).toMatchObject({blockedByMe: true, blockedByPeer: false, blocked: true});
        const asMaster = toChatSummary(c, "master");
        expect(asMaster).toMatchObject({blockedByMe: false, blockedByPeer: true, blocked: true});
    });

    it("carries orderId from metadata", () => {
        expect(toChatSummary(direct({metadata: {orderId: "o9"}}), "client").orderId).toBe("o9");
    });
});

describe("toChatSummary — GROUP (null pair)", () => {
    const group = (over: Partial<RawConversation> = {}): RawConversation => ({
        id: "g1", clientId: null, masterId: null, metadata: {name: "Squad"}, ...over,
    });

    it("discriminates a group by its null pair", () => {
        expect(toChatSummary(group(), "me").kind).toBe("group");
    });

    it("has no single counterpart and takes its name from metadata.name", () => {
        const s = toChatSummary(group(), "me");
        expect(s.counterpartId).toBe("");
        expect(s.name).toBe("Squad");
        expect(s.memberIds).toEqual([]); // list rows carry no roster; loaded per-group on open
    });

    it("never reports a per-pair block for a group", () => {
        const s = toChatSummary(group(), "me");
        expect(s).toMatchObject({blocked: false, blockedByMe: false, blockedByPeer: false});
    });

    it("treats a half-null pair as a group too (defensive)", () => {
        expect(toChatSummary(group({clientId: "x", masterId: null}), "me").kind).toBe("group");
    });
});
