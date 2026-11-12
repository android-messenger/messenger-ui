import {describe, it, expect, afterEach} from "vitest";
import {deviceTrust, files, isNativeApp} from "../platform";

const g = globalThis as { Capacitor?: unknown };

describe("platform", () => {
    afterEach(() => { delete g.Capacitor; });

    it("is a browser when there is no Capacitor bridge", () => {
        expect(isNativeApp()).toBe(false);
        expect(() => deviceTrust()).toThrow();
    });

    it("is a browser when Capacitor is not native (web build of Capacitor)", () => {
        g.Capacitor = {isNativePlatform: () => false, Plugins: {DeviceTrust: {}}};
        expect(isNativeApp()).toBe(false);
        expect(() => deviceTrust()).toThrow();
    });

    it("is the app when the bridge says native, and hands out the plugin", () => {
        const plugin = {getState: async () => ({state: "ACTIVE"})};
        g.Capacitor = {isNativePlatform: () => true, Plugins: {DeviceTrust: plugin}};
        expect(isNativeApp()).toBe(true);
        expect(deviceTrust()).toBe(plugin);
    });

    it("hands out the Files plugin only in the app", () => {
        expect(() => files()).toThrow();
        const plugin = {saveDownload: async () => ({saved: true})};
        g.Capacitor = {isNativePlatform: () => true, Plugins: {Files: plugin}};
        expect(files()).toBe(plugin);
    });

    it("treats a throwing bridge as a browser", () => {
        g.Capacitor = {isNativePlatform: () => { throw new Error("x"); }};
        expect(isNativeApp()).toBe(false);
    });
});
