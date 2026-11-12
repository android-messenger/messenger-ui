// @vitest-environment node
// Pure crypto + store, no DOM. Run in NODE (single JS realm): jsdom is a second realm, so an identity
// key round-tripped through the wrapped store (unwrapBytes → node-WebCrypto ArrayBuffer) fails libsignal's
// `instanceof ArrayBuffer` check on the SELF-HEAL republish. One realm matches the browser (single-realm).
import "fake-indexeddb/auto";
import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";
import {SignalStore} from "../signalStore";
import {ensureProvisioned, maybeReplenish} from "../provisioning";
import {wrapBytes, unwrapBytes, type WebCryptoWrapped} from "../deviceKey";

// Provisioning: generate device keys, persist PRIVATES wrapped, publish PUBLICS. These tests run against
// fake-indexeddb + node's WebCrypto and a mocked key-directory (fetch), so they exercise the real store +
// wrapping + KeyHelper without a browser or the live service.

const fetchMock = vi.fn();
beforeEach(() => {
    fetchMock.mockReset();
    // publish/replenish return a small count JSON
    fetchMock.mockReturnValue(Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ deviceId: "d", oneTimePreKeysRemaining: 20 })) }));
    vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("device key wrapping", () => {
    it("round-trips bytes through the non-extractable device key", async () => {
        const plain = new TextEncoder().encode("secret material").buffer;
        const w = await wrapBytes(plain);
        expect(new Uint8Array((w as WebCryptoWrapped).ct)).not.toEqual(new Uint8Array(plain));   // actually encrypted
        const back = await unwrapBytes(w);
        expect(new TextDecoder().decode(back)).toBe("secret material");
    });
});

describe("ensureProvisioned", () => {
    it("first run: generates identity, publishes a bundle (publics only), persists privates", async () => {
        const store = new SignalStore("e2ee-first");   // isolated db per test — the file shares one fake-indexeddb
        const { deviceId, provisioned } = await ensureProvisioned(store);
        expect(provisioned).toBe(true);
        expect(deviceId).toBeTruthy();

        // Published exactly once, to the publish endpoint, with a public bundle.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("/key-directory/v1/keys");
        const body = JSON.parse(init.body);
        expect(body.deviceId).toBe(deviceId);
        expect(typeof body.identityKey).toBe("string");            // base64 PUBLIC key
        expect(body.signedPreKey.signature).toBeTruthy();
        expect(body.oneTimePreKeys.length).toBe(20);
        // The body must NOT contain any private field.
        expect(JSON.stringify(body)).not.toMatch(/priv/i);

        // Privates are persisted + usable (identity keypair round-trips through the wrapped store).
        const idkp = await store.getIdentityKeyPair();
        expect(idkp?.privKey.byteLength).toBeGreaterThan(0);
        expect(await store.countPreKeys()).toBe(20);
        expect(await store.loadSignedPreKey(1)).toBeTruthy();
    });

    it("second run (known device): self-counts but does NOT re-publish or change identity", async () => {
        const store = new SignalStore("e2ee-second");
        const first = await ensureProvisioned(store);
        fetchMock.mockClear();
        const second = await ensureProvisioned(store);
        expect(second.provisioned).toBe(false);
        expect(second.deviceId).toBe(first.deviceId);
        // It checks the directory (self-count) to detect a missing device, but the
        // device is known here, so there is no re-publish.
        const urls = fetchMock.mock.calls.map((c) => c[0] as string);
        expect(urls.some((u) => u.startsWith("/key-directory/v1/keys/self/count"))).toBe(true);
        expect(urls).not.toContain("/key-directory/v1/keys");      // no publish POST
    });

    it("self-heal: local identity but the directory doesn't know the device → re-publishes", async () => {
        const store = new SignalStore("e2ee-heal");
        const first = await ensureProvisioned(store);
        // The directory 404s the self-count (device unknown, e.g. a prior publish
        // failed while it was unreachable) but accepts the re-publish.
        fetchMock.mockImplementation((url: string) =>
            String(url).includes("/keys/self/count")
                ? Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("") })
                : Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ deviceId: "d", oneTimePreKeysRemaining: 20 })) })
        );
        fetchMock.mockClear();
        const healed = await ensureProvisioned(store);
        expect(healed.provisioned).toBe(true);
        expect(healed.deviceId).toBe(first.deviceId);              // SAME device / identity, not rotated
        const urls = fetchMock.mock.calls.map((c) => c[0] as string);
        expect(urls).toContain("/key-directory/v1/keys");          // re-published the bundle
    });
});

describe("maybeReplenish", () => {
    it("replenishes when the pool is at/below low-water, no-ops otherwise", async () => {
        const store = new SignalStore("e2ee-replenish");
        await ensureProvisioned(store);
        fetchMock.mockClear();

        expect(await maybeReplenish("d", 20, store)).toBe(false);  // plenty left → no-op
        expect(fetchMock).not.toHaveBeenCalled();

        expect(await maybeReplenish("d", 3, store)).toBe(true);    // low → replenish
        expect(fetchMock.mock.calls[0][0]).toBe("/key-directory/v1/keys/one-time");
        expect(await store.countPreKeys()).toBe(37);               // 20 initial + top-up to target (20-3=17)
    });

    it("one-time-prekey ids are monotonic and never reused across store reloads (C1)", async () => {
        const store = new SignalStore("e2ee-c1");
        await ensureProvisioned(store);                            // seeds ids 1..20, floor persisted = 21
        const first = new Set(Array.from({length: 20}, (_, i) => i + 1));

        // Simulate a reload: a brand-new store instance over the SAME IndexedDB.
        const reloaded = new SignalStore("e2ee-c1");
        const ids = await reloaded.allocatePreKeyIds(20);
        expect(Math.min(...ids)).toBeGreaterThan(20);              // continues past the persisted floor
        expect(ids.some((id) => first.has(id))).toBe(false);       // no id from the first batch is reused
        // And the floor keeps advancing, never handing the same id twice.
        const more = await reloaded.allocatePreKeyIds(5);
        expect(Math.min(...more)).toBeGreaterThan(Math.max(...ids));
    });
});
