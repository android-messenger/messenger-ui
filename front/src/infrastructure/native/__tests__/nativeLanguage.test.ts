import {describe, it, expect, afterEach, vi} from "vitest";
import {reportNativeLanguage, resetNativeLanguage} from "../nativeLanguage.ts";

const g = globalThis as { Capacitor?: unknown };

describe("native language (S1 §5.5)", () => {
    afterEach(() => { delete g.Capacitor; resetNativeLanguage(); });

    it("reports the language once per change in the app", () => {
        const setLanguage = vi.fn(async () => {});
        g.Capacitor = {isNativePlatform: () => true, Plugins: {AppSettings: {setLanguage}}};
        reportNativeLanguage("es");
        reportNativeLanguage("es");
        reportNativeLanguage("en");
        expect(setLanguage.mock.calls).toEqual([[{lang: "es"}], [{lang: "en"}]]);
    });

    it("is a no-op in a browser and in an APK without the plugin", () => {
        expect(() => reportNativeLanguage("es")).not.toThrow();
        g.Capacitor = {isNativePlatform: () => true, Plugins: {}};
        expect(() => reportNativeLanguage("es")).not.toThrow();
    });
});
