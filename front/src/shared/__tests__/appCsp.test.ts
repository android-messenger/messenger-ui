import {describe, expect, it} from "vitest";
import {appConnectSources, appCsp, CSP_META, withCspMeta} from "../../../csp.app";

const HTML = `<!DOCTYPE html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n    <script type="module" src="/assets/index.js"></script>\n  </head>\n  <body><div id="root"></div></body>\n</html>`;

describe("the packaged UI's Content-Security-Policy", () => {
    it("lets the UI reach the API origin, its WebSocket and the attachments host — nothing else", () => {
        expect(appConnectSources("https://m.example.org:8443")).toEqual([
            "https://m.example.org:8443", "wss://m.example.org:8443", "https://m.example.org",
        ]);
        expect(appConnectSources("https://app.example.org")).toEqual(["https://app.example.org", "wss://app.example.org"]);
    });

    // Audit 2026-11-12, finding 4 (В): the full-size photo and the video are shown from their presigned URL.
    it("lets images and video come from the attachments host, and from nowhere else outside the package", () => {
        const csp = appCsp("https://m.example.org:8443").split("; ");
        expect(csp).toContain("img-src 'self' data: blob: https://m.example.org");
        expect(csp).toContain("media-src 'self' blob: https://m.example.org");
    });

    it("refuses a plain-http API origin, except the local stand", () => {
        expect(() => appConnectSources("http://m.example.org")).toThrow();
        expect(appConnectSources("http://localhost:9444")).toContain("ws://localhost:9444");
    });

    it("allows scripts only from the packaged assets: no inline, no eval", () => {
        const script = appCsp("https://m.example.org:8443").split("; ").find(d => d.startsWith("script-src"));
        expect(script).toBe("script-src 'self' 'wasm-unsafe-eval'");
        expect(appCsp("https://m.example.org:8443")).toContain("object-src 'none'");
        expect(appCsp("https://m.example.org:8443")).toContain("base-uri 'none'");
    });

    it("puts the policy first in <head>, before any script", () => {
        const out = withCspMeta(HTML, appCsp("https://m.example.org:8443"));
        expect(CSP_META.test(out)).toBe(true);
        expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("<script"));
        expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("charset"));
    });

    it("refuses an index.html with an inline script or a policy already in it", () => {
        expect(() => withCspMeta(HTML.replace("</head>", "<script>alert(1)</script></head>"), "x")).toThrow();
        expect(() => withCspMeta(withCspMeta(HTML, "default-src 'self'"), "x")).toThrow();
    });
});
