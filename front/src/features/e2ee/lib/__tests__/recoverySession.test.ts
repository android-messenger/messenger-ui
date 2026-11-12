// @vitest-environment node
// Orthogonal recovery (reviewer fix #1): the client-to-client repair path must NOT ride the normal ratchet
// — a stalled chain can't be healed by another message on that same chain. encryptRecovery/decryptRecovery
// run on a DEDICATED session at a distinct address, always re-established fresh, with each item AEAD-bound to
// (messageId, chatId). Same node-realm harness as secretSession.test (jsdom's second realm breaks X3DH).
import "fake-indexeddb/auto";
import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";
import {SignalProtocolAddress} from "@privacyresearch/libsignal-protocol-typescript";
import {SignalStore} from "../signalStore";
import {ensureProvisioned} from "../provisioning";
import {encryptTo, decryptFrom, encryptRecovery, decryptRecovery, RECOVERY_DEVICE_ID} from "../secretSession";

type Bundle = { deviceId: string; identityKey: string; signedPreKey: {id:number;publicKey:string;signature:string}; oneTimePreKeys: {id:number;publicKey:string}[] };
const dir: Record<string, Bundle[]> = {};
let currentUser = "alice";

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace("/key-directory/v1", "");
    if (init?.method === "POST" && path === "/keys") {
        const body = JSON.parse(init.body as string) as Bundle;
        (dir[currentUser] ||= []).push(body);
        return { ok: true, status: 200, text: async () => JSON.stringify({ deviceId: body.deviceId, oneTimePreKeysRemaining: body.oneTimePreKeys.length }) };
    }
    const m = path.match(/^\/keys\/([^/]+)$/);
    if (m) {
        const user = decodeURIComponent(m[1]);
        // Model the real directory: each fetch CONSUMES one OPK per device (shift), so a repeated fetch
        // hands out a fresh prekey and the receiver can process each exactly once (recovery re-X3DHs each batch).
        const devices = (dir[user] || []).map((b) => ({
            deviceId: b.deviceId, identityKey: b.identityKey, signedPreKey: b.signedPreKey,
            oneTimePreKey: b.oneTimePreKeys.shift() ?? null, oneTimePreKeysRemaining: b.oneTimePreKeys.length,
        }));
        return { ok: true, status: 200, text: async () => JSON.stringify({ userId: user, devices }) };
    }
    return { ok: false, status: 404, text: async () => "" };
});

beforeEach(() => { for (const k of Object.keys(dir)) delete dir[k]; vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());

async function provisionAs(user: string, dbName: string) {
    currentUser = user;
    const store = new SignalStore(dbName);
    const { deviceId } = await ensureProvisioned(store);
    return { store, deviceId };
}

describe("recovery — orthogonal session, AEAD-bound", () => {
    it("round-trips recovered items independently of any main-chain state", async () => {
        const alice = await provisionAs("alice", "e2ee-rec-a");
        const bob = await provisionAs("bob", "e2ee-rec-b");

        // No normal session established at all — recovery still works (it X3DHs its own).
        const ciphers = await encryptRecovery(alice.store, "bob", "chatX", [
            {mid: "m1", text: "recovered one"},
            {mid: "m2", text: "recovered two 🔐"},
        ]);
        expect(ciphers.map((c) => c.mid)).toEqual(["m1", "m2"]);
        expect(JSON.stringify(ciphers)).not.toContain("recovered");     // ciphertext only

        const out = await decryptRecovery(bob.store, "alice", "chatX", ciphers);
        expect(out).toEqual([{mid: "m1", text: "recovered one"}, {mid: "m2", text: "recovered two 🔐"}]);
    });

    it("works even after the NORMAL ratchet has advanced (the stall case)", async () => {
        const alice = await provisionAs("alice", "e2ee-rec-a2");
        const bob = await provisionAs("bob", "e2ee-rec-b2");
        // Drive the normal chain forward a few messages, then heal a "missed" one out-of-band.
        for (const t of ["a", "b", "c"]) {
            const e = await encryptTo(alice.store, "bob", alice.deviceId, t);
            await decryptFrom(bob.store, "alice", bob.deviceId, e);
        }
        const ciphers = await encryptRecovery(alice.store, "bob", "chatX", [{mid: "missed", text: "the lost line"}]);
        const out = await decryptRecovery(bob.store, "alice", "chatX", ciphers);
        expect(out).toEqual([{mid: "missed", text: "the lost line"}]);
    });

    it("tears down the receiver's recovery lane after a batch (bounded, no archive buildup)", async () => {
        const alice = await provisionAs("alice", "e2ee-rec-lane-a");
        const bob = await provisionAs("bob", "e2ee-rec-lane-b");
        const ciphers = await encryptRecovery(alice.store, "bob", "c", [{mid: "1", text: "x"}]);
        await decryptRecovery(bob.store, "alice", "c", ciphers);
        const laneAddr = new SignalProtocolAddress("alice", RECOVERY_DEVICE_ID).toString();
        expect(await bob.store.loadSession(laneAddr)).toBeUndefined();   // cleaned up
    });

    it("repeated recovery batches each re-establish a fresh session", async () => {
        const alice = await provisionAs("alice", "e2ee-rec-a3");
        const bob = await provisionAs("bob", "e2ee-rec-b3");
        const c1 = await encryptRecovery(alice.store, "bob", "c", [{mid: "1", text: "first batch"}]);
        expect((await decryptRecovery(bob.store, "alice", "c", c1))[0].text).toBe("first batch");
        const c2 = await encryptRecovery(alice.store, "bob", "c", [{mid: "2", text: "second batch"}]);
        expect((await decryptRecovery(bob.store, "alice", "c", c2))[0].text).toBe("second batch");
    });

    it("drops an item whose binding was tampered (relabelled mid, or wrong chat)", async () => {
        const alice = await provisionAs("alice", "e2ee-rec-a4");
        const bob = await provisionAs("bob", "e2ee-rec-b4");
        const ciphers = await encryptRecovery(alice.store, "bob", "chatRight", [{mid: "real", text: "bound text"}]);

        // Relabel the outer mid: the inner AEAD-bound mid no longer matches → dropped.
        const relabelled = ciphers.map((c) => ({...c, mid: "forged"}));
        expect(await decryptRecovery(bob.store, "alice", "chatRight", relabelled)).toEqual([]);

        // Right item but requester expects a DIFFERENT chat → binding mismatch → dropped.
        const alice2 = await provisionAs("alice", "e2ee-rec-a4");   // fresh sender session for a clean batch
        const c2 = await encryptRecovery(alice2.store, "bob", "chatRight", [{mid: "real", text: "bound text"}]);
        expect(await decryptRecovery(bob.store, "alice", "chatWrong", c2)).toEqual([]);
    });
});
