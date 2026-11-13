import {vi} from "vitest";

// The Android app for tests: a Capacitor bridge with a fake DeviceTrust plugin. The Vault blob is the
// purpose tag + the data, so a wrong purpose fails the way AEAD would.

export function installFakeApp() {
    const plugin = {
        vaultWrap: vi.fn(async ({data, purpose}: {data: string; purpose: string}) => ({blob: btoa(purpose + "|") + "." + data})),
        vaultUnwrap: vi.fn(async ({blob, purpose}: {blob: string; purpose: string}) => {
            const [tag, data] = blob.split(".");
            if (atob(tag) !== purpose + "|") throw Object.assign(new Error("vault unwrap failed"), {code: "VAULT_CORRUPT"});
            return {data};
        }),
        e2eeWipe: vi.fn(async () => {}),
        sessionEnd: vi.fn(async () => ({ended: true})),
    };
    const g = globalThis as {Capacitor?: unknown};
    g.Capacitor = {isNativePlatform: () => true, Plugins: {DeviceTrust: plugin}};
    return {plugin, uninstall: () => { delete g.Capacitor; }};
}
