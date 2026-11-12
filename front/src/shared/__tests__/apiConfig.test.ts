import {describe, expect, it, vi} from "vitest";

// The app build (--mode app) sets VITE_API_ORIGIN; the web build leaves it empty (host-relative URLs).
describe("API origin (web vs app build)", () => {
    it("web build: host-relative bases, WebSocket on the page's own host", async () => {
        vi.resetModules();
        vi.stubEnv("VITE_API_ORIGIN", "");
        const api = await import("@/shared/config/api.ts");
        const {kratosUrl} = await import("@/shared/config/kratos.ts");
        expect(api.MESSENGER_API).toBe("/messenger/api");
        expect(kratosUrl).toBe("/.ory/kratos/public");
        expect(api.apiOrigin()).toBe(window.location.origin);
        const proto = window.location.protocol === "https:" ? "wss" : "ws";
        expect(api.messengerWsUrl()).toBe(`${proto}://${window.location.host}/messenger/ws`);
        vi.unstubAllEnvs();
    });

    it("app build: every base on the API origin, wss on its port", async () => {
        vi.resetModules();
        vi.stubEnv("VITE_API_ORIGIN", "https://app.example.org:8443/");
        const api = await import("@/shared/config/api.ts");
        const {kratosUrl} = await import("@/shared/config/kratos.ts");
        expect(api.API_ORIGIN).toBe("https://app.example.org:8443");
        expect(api.MESSENGER_API).toBe("https://app.example.org:8443/messenger/api");
        expect(api.WEBPUSH_BASE).toBe("https://app.example.org:8443/webpush");
        expect(kratosUrl).toBe("https://app.example.org:8443/.ory/kratos/public");
        expect(api.apiOrigin()).toBe("https://app.example.org:8443");
        expect(api.messengerWsUrl()).toBe("wss://app.example.org:8443/messenger/ws");
        vi.unstubAllEnvs();
    });
});
