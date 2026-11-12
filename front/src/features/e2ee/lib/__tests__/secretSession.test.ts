// @vitest-environment node
// Pure crypto/logic — run in NODE, not jsdom. jsdom gives a second JS realm (its own ArrayBuffer), so a
// node-WebCrypto ArrayBuffer fails the library's `instanceof ArrayBuffer` check even with correct bytes.
// One realm (node) matches production (a browser is single-realm) and lets X3DH validate our keys.
import "fake-indexeddb/auto";
import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";
import {SignalStore} from "../signalStore";
import {ensureProvisioned} from "../provisioning";
import {encryptTo, decryptFrom, invalidatePeer} from "../secretSession";
import {b64} from "../deviceKey";

// End-to-end 2c+2d: two independent "devices" (isolated IndexedDB stores) provision into a shared FAKE
// directory, then Alice encrypts to Bob and Bob decrypts — through the REAL SignalStore + wrapping + the
// real X3DH/Double Ratchet. This is the proof the crypto engine works before wiring it to the chat path.

// A stateful in-memory stand-in for the key directory: publish stores a device bundle under the
// caller's userId; fetch returns them (and would consume an OPK — we keep it simple and don't deplete).
type Bundle = { deviceId: string; identityKey: string; signedPreKey: {id:number;publicKey:string;signature:string}; oneTimePreKeys: {id:number;publicKey:string}[]; lastResortPreKey?: {id:number;publicKey:string} };
const dir: Record<string, Bundle[]> = {};
let currentUser = "alice";                    // whom the auth header would identify

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace("/key-directory/v1", "");
    if (init?.method === "POST" && path === "/keys") {
        const body = JSON.parse(init.body as string) as Bundle;
        (dir[currentUser] ||= []).push(body);
        return { ok: true, status: 200, text: async () => JSON.stringify({ deviceId: body.deviceId, oneTimePreKeysRemaining: body.oneTimePreKeys.length }) };
    }
    const m = path.match(/^\/keys\/([^/]+)$/);   // GET /keys/{userId}
    if (m) {
        const user = decodeURIComponent(m[1]);
        const devices = (dir[user] || []).map((b) => ({
            deviceId: b.deviceId, identityKey: b.identityKey, signedPreKey: b.signedPreKey,
            // Mirror the server: serve a normal OPK if any, else the reusable last-resort key (not consumed).
            oneTimePreKey: b.oneTimePreKeys[0] ?? b.lastResortPreKey ?? null,
            oneTimePreKeyIsLastResort: !b.oneTimePreKeys[0] && !!b.lastResortPreKey,
            oneTimePreKeysRemaining: b.oneTimePreKeys.length,
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

describe("secretSession — X3DH + Double Ratchet, end to end", () => {
    it("Alice encrypts to Bob; Bob decrypts (X3DH established from the directory bundle)", async () => {
        const alice = await provisionAs("alice", "e2ee-alice");
        const bob = await provisionAs("bob", "e2ee-bob");

        const env = await encryptTo(alice.store, "bob", alice.deviceId, "hola bob 🔐");
        expect(env.alg).toBe("signal");
        expect(env.from).toBe(alice.deviceId);
        expect(env.to[bob.deviceId]).toBeTruthy();            // encrypted to bob's device
        // The envelope carries ONLY ciphertext — no plaintext leaks.
        expect(JSON.stringify(env)).not.toContain("hola");

        const plain = await decryptFrom(bob.store, "alice", bob.deviceId, env);
        expect(plain).toBe("hola bob 🔐");
    });

    it("steady-state ratchet: several messages both directions", async () => {
        const alice = await provisionAs("alice", "e2ee-a2");
        const bob = await provisionAs("bob", "e2ee-b2");

        const e1 = await encryptTo(alice.store, "bob", alice.deviceId, "m1");
        expect(await decryptFrom(bob.store, "alice", bob.deviceId, e1)).toBe("m1");
        const e2 = await encryptTo(alice.store, "bob", alice.deviceId, "m2");
        expect(await decryptFrom(bob.store, "alice", bob.deviceId, e2)).toBe("m2");
        // Bob → Alice
        const r1 = await encryptTo(bob.store, "alice", bob.deviceId, "reply");
        expect(await decryptFrom(alice.store, "bob", alice.deviceId, r1)).toBe("reply");
    });

    it("encrypting to a peer with NO published keys throws NO_PEER_KEYS (not a vague failure)", async () => {
        const alice = await provisionAs("alice", "e2ee-nk");
        // "carol" never provisioned → directory has nothing → 404 → empty roster → NO_PEER_KEYS.
        await expect(encryptTo(alice.store, "carol", alice.deviceId, "hi")).rejects.toThrow("NO_PEER_KEYS");
    });

    it("out-of-order deliver (3,1,2) all decrypt; a duplicate is rejected", async () => {
        const alice = await provisionAs("alice", "e2ee-a3");
        const bob = await provisionAs("bob", "e2ee-b3");
        // establish
        const e0 = await encryptTo(alice.store, "bob", alice.deviceId, "hello");
        await decryptFrom(bob.store, "alice", bob.deviceId, e0);

        const m1 = await encryptTo(alice.store, "bob", alice.deviceId, "one");
        const m2 = await encryptTo(alice.store, "bob", alice.deviceId, "two");
        const m3 = await encryptTo(alice.store, "bob", alice.deviceId, "three");
        expect(await decryptFrom(bob.store, "alice", bob.deviceId, m3)).toBe("three");   // ahead
        expect(await decryptFrom(bob.store, "alice", bob.deviceId, m1)).toBe("one");     // gap fill
        expect(await decryptFrom(bob.store, "alice", bob.deviceId, m2)).toBe("two");
        // replay m1 → the message key is gone
        await expect(decryptFrom(bob.store, "alice", bob.deviceId, m1)).rejects.toBeTruthy();
    });

    it("peer re-provisions (new device) → sender heals; the stale peer identity is pruned", async () => {
        const alice = await provisionAs("alice", "e2ee-rp-a");
        let bob = await provisionAs("bob", "e2ee-rp-b1");
        const oldBobDevice = bob.deviceId;

        // Establish + exchange once — Alice pins Bob's ORIGINAL device identity.
        const e0 = await encryptTo(alice.store, "bob", alice.deviceId, "hi");
        expect(await decryptFrom(bob.store, "alice", bob.deviceId, e0)).toBe("hi");

        // Bob re-provisions on a cleared store → NEW deviceId + identity. The directory now
        // reflects ONLY the fresh device (it replaced Bob's entry).
        delete dir["bob"];
        bob = await provisionAs("bob", "e2ee-rp-b2");
        expect(bob.deviceId).not.toBe(oldBobDevice);

        // With sender-side caching, Alice's NEXT send still targets the cached OLD device (she hasn't
        // been told Bob moved) — the fresh Bob can't decrypt it. This is the mis-addressed case that, in
        // production, makes Bob's new device emit a rekey hint. Simulate that hint via invalidatePeer.
        const stale = await encryptTo(alice.store, "bob", alice.deviceId, "still there?");
        await expect(decryptFrom(bob.store, "alice", bob.deviceId, stale)).rejects.toBeTruthy();
        await invalidatePeer(alice.store, "bob");   // rekey hint → drop cached roster → re-resolve next send

        // Alice resends → re-resolves from the directory, establishes a session to the fresh device, and
        // the fresh Bob decrypts.
        const e1 = await encryptTo(alice.store, "bob", alice.deviceId, "resent");
        expect(await decryptFrom(bob.store, "alice", bob.deviceId, e1)).toBe("resent");

        // The stale OLD-device identity must have been pruned, so the safety number is now computed
        // over Bob's CURRENT identity — this is exactly what makes the numbers reconverge.
        const pinned = await alice.store.getPeerIdentity("bob");
        const bobCurrentOwn = (await bob.store.getIdentityKeyPair())!.pubKey;
        expect(pinned).toBeTruthy();
        expect(b64(pinned!)).toBe(b64(bobCurrentOwn));

        // And the healed session is bidirectional.
        const r1 = await encryptTo(bob.store, "alice", bob.deviceId, "yes");
        expect(await decryptFrom(alice.store, "bob", alice.deviceId, r1)).toBe("yes");
    });

    // Count GET fetches of a peer's roster (each would consume an OPK server-side).
    const rosterFetches = (user: string) =>
        fetchMock.mock.calls.filter(([url, init]) =>
            (init === undefined || (init as RequestInit).method === undefined || (init as RequestInit).method === "GET")
            && String(url).includes(`/keys/${user}`)).length;

    it("caches the peer roster: only the FIRST send fetches (no per-send OPK burn)", async () => {
        const alice = await provisionAs("alice", "e2ee-cache-a");
        await provisionAs("bob", "e2ee-cache-b");
        currentUser = "alice";

        const before = rosterFetches("bob");
        await encryptTo(alice.store, "bob", alice.deviceId, "1");   // cache miss → 1 fetch
        const afterFirst = rosterFetches("bob");
        expect(afterFirst).toBe(before + 1);

        await encryptTo(alice.store, "bob", alice.deviceId, "2");   // cached → no fetch
        await encryptTo(alice.store, "bob", alice.deviceId, "3");   // cached → no fetch
        expect(rosterFetches("bob")).toBe(afterFirst);             // unchanged: sessions reused
    });

    it("invalidatePeer forces the next send to re-fetch the roster", async () => {
        const alice = await provisionAs("alice", "e2ee-inv-a");
        await provisionAs("bob", "e2ee-inv-b");
        currentUser = "alice";

        await encryptTo(alice.store, "bob", alice.deviceId, "1");   // establishes + caches
        const n = rosterFetches("bob");
        await encryptTo(alice.store, "bob", alice.deviceId, "2");   // cached → no fetch
        expect(rosterFetches("bob")).toBe(n);

        await invalidatePeer(alice.store, "bob");                   // rekey hint / decrypt-fail
        await encryptTo(alice.store, "bob", alice.deviceId, "3");   // re-resolves → +1 fetch
        expect(rosterFetches("bob")).toBe(n + 1);
    });

    it("last-resort prekey: reusable across peers when the pool is exhausted", async () => {
        const bob = await provisionAs("bob", "e2ee-lrk-bob");
        // Exhaust Bob's NORMAL pool in the directory → a fetch now serves his reusable last-resort key.
        dir["bob"][0].oneTimePreKeys = [];
        expect(dir["bob"][0].lastResortPreKey).toBeTruthy();       // provisioning published one

        const alice = await provisionAs("alice", "e2ee-lrk-alice");
        const carol = await provisionAs("carol", "e2ee-lrk-carol");

        // Alice establishes via Bob's last-resort key and Bob decrypts.
        const ea = await encryptTo(alice.store, "bob", alice.deviceId, "from alice");
        expect(await decryptFrom(bob.store, "alice", bob.deviceId, ea)).toBe("from alice");

        // Carol establishes via the SAME last-resort key — Bob still decrypts, proving the last-resort
        // private was NOT deleted after Alice's session (reusable on the recipient side).
        const ec = await encryptTo(carol.store, "bob", carol.deviceId, "from carol");
        expect(await decryptFrom(bob.store, "carol", bob.deviceId, ec)).toBe("from carol");
    });

    it("last-resort reserved id never enters the normal one-time-prekey id space", async () => {
        const bob = await provisionAs("bob", "e2ee-lrk-ids");
        const ids = await bob.store.allocatePreKeyIds(5);
        for (const id of ids) expect(id).toBeLessThan(0x7fffffff);   // LAST_RESORT_PREKEY_ID
    });
});
