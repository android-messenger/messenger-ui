import {describe, it, expect, vi, beforeEach} from "vitest";

// buildResponse orchestration: we re-send ONLY messages we ourselves sent, to their ORIGINAL recipient, in
// the requested chat (authorization — closes a plaintext oracle); everything else is NACK'd via `missing`.
// Heavy deps (provisioning, at-rest, the ratchet) are mocked — this asserts the split + auth, not the crypto.
vi.mock("../../lib/provisioning.ts", () => ({ensureProvisioned: vi.fn(async () => ({store: {}, deviceId: "dev"}))}));
const loadPlaintextRecord = vi.fn();
vi.mock("../../lib/atRest.ts", () => ({loadPlaintextRecord: (...a: unknown[]) => loadPlaintextRecord(...a), E2EE_PLAINTEXT_TTL_MS: 172_800_000}));
const encryptRecovery = vi.fn(async (_s: unknown, _u: string, _c: string, items: Array<{mid: string; text: string}>) =>
    items.map((it) => ({mid: it.mid, t: 3, b: "cipher:" + it.mid})));
vi.mock("../../lib/secretSession.ts", () => ({encryptRecovery: (...a: Parameters<typeof encryptRecovery>) => encryptRecovery(...a)}));

import {buildResponse, RECOVER_RESP} from "../protocol.ts";

// A stored SENT record addressed to `requester` in `chatX`.
const sent = (text: string) => ({text, chatId: "chatX", to: "requester"});

beforeEach(() => { loadPlaintextRecord.mockReset(); encryptRecovery.mockClear(); });

describe("buildResponse — recover vs NACK, with authorization", () => {
    it("splits held ids into items and unheld ids into missing", async () => {
        loadPlaintextRecord.mockImplementation(async (id: string) => (id === "have1" || id === "have2" ? sent("text-" + id) : null));
        const resp = await buildResponse("requester", "chatX", ["have1", "gone1", "have2", "gone2"]);

        expect(resp.type).toBe(RECOVER_RESP);
        expect(resp.to).toBe("requester");
        expect(resp.conversationId).toBe("chatX");
        expect(resp.items.map((i) => i.mid)).toEqual(["have1", "have2"]);
        expect(resp.missing).toEqual(["gone1", "gone2"]);
        expect(encryptRecovery).toHaveBeenCalledWith({}, "requester", "chatX", [
            {mid: "have1", text: "text-have1"}, {mid: "have2", text: "text-have2"},
        ]);
    });

    it("NACKs an id we hold but whose recipient ISN'T the requester (no plaintext oracle)", async () => {
        loadPlaintextRecord.mockResolvedValue({text: "secret for someone else", chatId: "chatX", to: "victim"});
        const resp = await buildResponse("attacker", "chatX", ["m1"]);
        expect(resp.items).toEqual([]);
        expect(resp.missing).toEqual(["m1"]);
        expect(encryptRecovery).not.toHaveBeenCalled();
    });

    it("NACKs an id from a DIFFERENT chat, and a RECEIVED record (no `to`)", async () => {
        loadPlaintextRecord.mockImplementation(async (id: string) =>
            id === "otherChat" ? {text: "x", chatId: "chatZ", to: "requester"}
            : id === "received" ? {text: "y", chatId: "chatX"}            // no `to` → we didn't send it
            : null);
        const resp = await buildResponse("requester", "chatX", ["otherChat", "received"]);
        expect(resp.items).toEqual([]);
        expect(resp.missing).toEqual(["otherChat", "received"]);
    });

    it("all-unheld → no ciphers, every id NACKed (ratchet not invoked)", async () => {
        loadPlaintextRecord.mockResolvedValue(null);
        const resp = await buildResponse("requester", "chatX", ["a", "b"]);
        expect(resp.items).toEqual([]);
        expect(resp.missing).toEqual(["a", "b"]);
        expect(encryptRecovery).not.toHaveBeenCalled();
    });

    it("re-encryption failure still returns the NACKs (requester retries the rest)", async () => {
        loadPlaintextRecord.mockImplementation(async (id: string) => (id === "have" ? sent("t") : null));
        encryptRecovery.mockRejectedValueOnce(new Error("no peer keys right now"));
        const resp = await buildResponse("requester", "chatX", ["have", "gone"]);
        expect(resp.items).toEqual([]);                 // couldn't encrypt → not delivered, will retry
        expect(resp.missing).toEqual(["gone"]);         // but the definitive NACK still goes out
    });
});
