// @vitest-environment node
import {describe, it, expect, beforeEach, afterEach, vi} from "vitest";
import {
    wrapBytes, abortVaultWaits, isVaultWaitLong, onVaultWait,
    VAULT_LOCKED_POLL_MS, VAULT_WAIT_NOTICE_MS, VAULT_WAIT_ABORTED,
} from "../deviceKey";

// Spec 001, story 5, finding 47: a Vault call repeated after VAULT_LOCKED without a limit and without a
// word to the user; nothing could stop it, logout included.

const locked = () => Object.assign(new Error("vault locked"), {code: "VAULT_LOCKED"});
const vault = {vaultWrap: vi.fn(), vaultUnwrap: vi.fn()};
const g = globalThis as {Capacitor?: unknown};
const bytes = new TextEncoder().encode("k");

describe("waiting for the locked Vault", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        g.Capacitor = {isNativePlatform: () => true, Plugins: {DeviceTrust: vault}};
        vault.vaultWrap.mockReset();
    });
    afterEach(() => { abortVaultWaits(); vi.useRealTimers(); delete g.Capacitor; });

    it("a short wait is not shown", async () => {
        vault.vaultWrap.mockRejectedValueOnce(locked()).mockResolvedValue({blob: "b"});
        const seen: boolean[] = [];
        const off = onVaultWait((v) => seen.push(v));
        const p = wrapBytes(bytes);
        await vi.advanceTimersByTimeAsync(VAULT_LOCKED_POLL_MS);
        await expect(p).resolves.toEqual({kind: "native", blob: "b"});
        expect(seen).toEqual([]);
        expect(isVaultWaitLong()).toBe(false);
        off();
    });

    it("a wait longer than the notice time is shown, and the notice goes away when the Vault opens", async () => {
        vault.vaultWrap.mockRejectedValue(locked());
        const seen: boolean[] = [];
        const off = onVaultWait((v) => seen.push(v));
        const p = wrapBytes(bytes);
        await vi.advanceTimersByTimeAsync(VAULT_WAIT_NOTICE_MS + VAULT_LOCKED_POLL_MS);
        expect(isVaultWaitLong()).toBe(true);
        expect(seen).toEqual([true]);

        vault.vaultWrap.mockResolvedValue({blob: "b"});   // the phone is unlocked
        await vi.advanceTimersByTimeAsync(VAULT_LOCKED_POLL_MS);
        await expect(p).resolves.toEqual({kind: "native", blob: "b"});
        expect(isVaultWaitLong()).toBe(false);
        expect(seen).toEqual([true, false]);
        off();
    });

    it("logout stops the wait: the call ends with VAULT_WAIT_ABORTED and asks the Vault no more", async () => {
        vault.vaultWrap.mockRejectedValue(locked());
        const p = wrapBytes(bytes);
        const settled = p.then(() => "ok", (e: {code?: string}) => e.code);
        await vi.advanceTimersByTimeAsync(VAULT_WAIT_NOTICE_MS + VAULT_LOCKED_POLL_MS);
        expect(isVaultWaitLong()).toBe(true);

        abortVaultWaits();
        expect(isVaultWaitLong()).toBe(false);
        await vi.advanceTimersByTimeAsync(VAULT_LOCKED_POLL_MS);
        expect(await settled).toBe(VAULT_WAIT_ABORTED);
        const calls = vault.vaultWrap.mock.calls.length;
        await vi.advanceTimersByTimeAsync(VAULT_LOCKED_POLL_MS * 5);
        expect(vault.vaultWrap.mock.calls.length).toBe(calls);
    });

    it("a call started after the abort waits as usual", async () => {
        abortVaultWaits();
        vault.vaultWrap.mockRejectedValueOnce(locked()).mockResolvedValue({blob: "b2"});
        const p = wrapBytes(bytes);
        await vi.advanceTimersByTimeAsync(VAULT_LOCKED_POLL_MS);
        await expect(p).resolves.toEqual({kind: "native", blob: "b2"});
    });
});
