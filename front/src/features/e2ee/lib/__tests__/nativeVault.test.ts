// @vitest-environment node
import "fake-indexeddb/auto";
import {describe, it, expect, beforeEach, afterEach, vi} from "vitest";
import {b64, unb64, unwrapBytes, wrapBytes, VAULT_LOCKED_POLL_MS, type Wrapped} from "../deviceKey";
import {loadPlaintext, plaintextStats, savePlaintext} from "../atRest";

// S1-5: wrapBytes/unwrapBytes go to the Android app's Vault (DeviceTrust plugin) with a purpose. Outside
// the app nothing is wrapped; a record of an older browser version (no `kind`) is unreadable.

// A fake Vault: the blob is the purpose tag + the data, so a wrong purpose fails like AEAD would.
const vault = {
    vaultWrap: vi.fn(async ({data, purpose}: {data: string; purpose: string}) => ({blob: btoa(purpose + "|") + "." + data})),
    vaultUnwrap: vi.fn(async ({blob, purpose}: {blob: string; purpose: string}) => {
        const [tag, data] = blob.split(".");
        if (atob(tag) !== purpose + "|") throw Object.assign(new Error("vault unwrap failed"), {code: "VAULT_CORRUPT"});
        return {data};
    }),
};
const g = globalThis as { Capacitor?: unknown };
const bytes = (s: string) => new TextEncoder().encode(s);

describe("deviceKey in the Android app (native Vault)", () => {
    beforeEach(() => {
        g.Capacitor = {isNativePlatform: () => true, Plugins: {DeviceTrust: vault}};
        vault.vaultWrap.mockClear(); vault.vaultUnwrap.mockClear();
    });
    afterEach(() => { delete g.Capacitor; });

    it("wraps through the Vault with the e2ee purpose by default", async () => {
        const w = await wrapBytes(bytes("secret key"));
        expect(w).toEqual({kind: "native", blob: expect.any(String)});
        expect(vault.vaultWrap).toHaveBeenCalledWith({data: b64(bytes("secret key").buffer), purpose: "e2ee"});
        expect(new TextDecoder().decode(await unwrapBytes(w))).toBe("secret key");
        expect(vault.vaultUnwrap).toHaveBeenCalledWith({blob: (w as {blob: string}).blob, purpose: "e2ee"});
    });

    it("a blob of one purpose does not unwrap as another", async () => {
        const w = await wrapBytes(bytes("k"), "e2ee");
        await expect(unwrapBytes(w, "e2ee-plaintext")).rejects.toMatchObject({code: "VAULT_CORRUPT"});
    });

    it("never touches WebCrypto: a WebCrypto record is refused, no device key is created", async () => {
        const subtle = vi.spyOn(crypto.subtle, "generateKey");
        const legacy: Wrapped = {iv: new Uint8Array(12).buffer, ct: new Uint8Array(16).buffer};
        await expect(unwrapBytes(legacy)).rejects.toThrow(/older browser version/);
        await wrapBytes(bytes("x"));
        expect(subtle).not.toHaveBeenCalled();
        subtle.mockRestore();
    });

    it("stored plaintext uses the e2ee-plaintext purpose", async () => {
        await savePlaintext("n1", "chat1", "hola");
        expect(vault.vaultWrap).toHaveBeenLastCalledWith(expect.objectContaining({purpose: "e2ee-plaintext"}));
        expect(await loadPlaintext("n1")).toBe("hola");
        expect(vault.vaultUnwrap).toHaveBeenLastCalledWith(expect.objectContaining({purpose: "e2ee-plaintext"}));
        expect((await plaintextStats()).bytes).toBeGreaterThan(0);
    });
});

describe("VAULT_LOCKED in the Android app (screen locked or RASP pass pending)", () => {
    const locked = () => Object.assign(new Error("vault locked"), {code: "VAULT_LOCKED"});
    const callbacks: Array<() => void> = [];
    const pushPlugin = {
        addListener: vi.fn((_e: string, cb: () => void) => {
            callbacks.push(cb);
            return {remove: vi.fn(async () => {})};
        }),
    };
    /** The app returns to the foreground: the wait registered last hears it. */
    const foreground = (n: number) => {
        expect(pushPlugin.addListener).toHaveBeenCalledTimes(n);
        expect(pushPlugin.addListener).toHaveBeenLastCalledWith("appForeground", expect.any(Function));
        callbacks[n - 1]();
    };

    beforeEach(() => {
        g.Capacitor = {isNativePlatform: () => true, Plugins: {DeviceTrust: vault, Push: pushPlugin}};
        vault.vaultWrap.mockClear(); vault.vaultUnwrap.mockClear(); pushPlugin.addListener.mockClear();
        callbacks.length = 0;
    });
    afterEach(() => { delete g.Capacitor; vi.useRealTimers(); });

    it("waits for the app's return to the foreground and repeats the call", async () => {
        const w = await wrapBytes(bytes("ratchet"));
        vault.vaultUnwrap.mockRejectedValueOnce(locked()).mockRejectedValueOnce(locked());
        const p = unwrapBytes(w);
        await vi.waitFor(() => foreground(1));
        await vi.waitFor(() => foreground(2)); // locked again → a new wait
        expect(new TextDecoder().decode(await p)).toBe("ratchet");
        expect(vault.vaultUnwrap).toHaveBeenCalledTimes(3);
    });

    it("concurrent locked calls share one wait", async () => {
        vault.vaultWrap.mockRejectedValueOnce(locked()).mockRejectedValueOnce(locked());
        const a = wrapBytes(bytes("a")), b = wrapBytes(bytes("b"));
        await vi.waitFor(() => expect(vault.vaultWrap).toHaveBeenCalledTimes(2));
        foreground(1);
        await expect(Promise.all([a, b])).resolves.toHaveLength(2);
        expect(pushPlugin.addListener).toHaveBeenCalledTimes(1);
    });

    it("without a foreground event the call is repeated after the poll interval", async () => {
        vi.useFakeTimers();
        vault.vaultWrap.mockRejectedValueOnce(locked());
        const p = wrapBytes(bytes("x"));
        await vi.advanceTimersByTimeAsync(VAULT_LOCKED_POLL_MS);
        await expect(p).resolves.toMatchObject({kind: "native"});
        expect(vault.vaultWrap).toHaveBeenCalledTimes(2);
    });

    it("other errors are not repeated", async () => {
        vault.vaultUnwrap.mockRejectedValueOnce(Object.assign(new Error("gone"), {code: "VAULT_KEY_GONE"}));
        await expect(unwrapBytes({kind: "native", blob: "AAAA"})).rejects.toMatchObject({code: "VAULT_KEY_GONE"});
        expect(vault.vaultUnwrap).toHaveBeenCalledTimes(1);
    });
});

describe("deviceKey in a browser", () => {
    it("a native blob cannot be opened outside the app", async () => {
        await expect(unwrapBytes({kind: "native", blob: "AAAA"})).rejects.toThrow(/Android app/);
    });

    it("nothing is wrapped outside the app: there is no key there", async () => {
        await expect(wrapBytes(bytes("b"))).rejects.toThrow(/Android app/);
        expect(await savePlaintext("b1", "chat1", "hola")).toBe(false);
        expect(await loadPlaintext("b1")).toBeNull();
        expect(unb64(b64(bytes("b").buffer)).byteLength).toBe(1);
    });
});
