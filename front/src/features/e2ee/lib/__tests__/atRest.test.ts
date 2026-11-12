// @vitest-environment node
import "fake-indexeddb/auto";
import {describe, it, expect} from "vitest";
import {savePlaintext, loadPlaintext, deletePlaintextForChat, sweepExpired} from "../atRest";

// The at-rest store keeps decrypted secret plaintext (device-key-wrapped), keyed by message id, tagged with
// chatId + savedAt. Verify: round-trip, per-chat wipe (delete chat), and disappearing expiry.
// (Expiry is forced with a negative TTL — every record is then "older than the cutoff" — rather than fake
// timers, which stall fake-indexeddb's timer-driven async.)

describe("atRest plaintext store", () => {
    it("round-trips a wrapped plaintext by id", async () => {
        await savePlaintext("m1", "c1", "hola secreto");
        expect(await loadPlaintext("m1")).toBe("hola secreto");
    });

    it("deletePlaintextForChat wipes only that chat's messages", async () => {
        await savePlaintext("a1", "chatA", "A one");
        await savePlaintext("a2", "chatA", "A two");
        await savePlaintext("b1", "chatB", "B one");
        await deletePlaintextForChat("chatA");
        expect(await loadPlaintext("a1")).toBeNull();
        expect(await loadPlaintext("a2")).toBeNull();
        expect(await loadPlaintext("b1")).toBe("B one");   // other chat untouched
    });

    it("expires plaintext older than the TTL (disappearing messages)", async () => {
        await savePlaintext("old", "c", "will vanish");
        expect(await loadPlaintext("old", 60_000)).toBe("will vanish");   // within TTL → still there
        expect(await loadPlaintext("old", -1)).toBeNull();               // negative TTL → treated as expired
        expect(await loadPlaintext("old")).toBeNull();                   // and actually removed
    });

    it("sweepExpired removes everything older than the cutoff", async () => {
        await savePlaintext("s1", "c", "gone");
        await savePlaintext("s2", "c", "gone too");
        const removed = await sweepExpired(-1);   // cutoff in the future → everything is older
        expect(removed).toBeGreaterThanOrEqual(2);
        expect(await loadPlaintext("s1")).toBeNull();
    });
});
