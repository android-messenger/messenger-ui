// Content-Security-Policy of the build packaged into the Android APK (`--mode app`).
//
// The web build gets its policy as a response header from server.mjs. The packaged UI is served by
// the app's local asset server, which sends no such header — so the policy travels inside index.html
// as a <meta>. It matters more here than on the web: a script injected into this page reaches the
// native bridge and, through it, the Vault that unwraps the Signal keys.
//
// Same policy as server.mjs, with two differences forced by the packaging:
//   - connect-src names the API origin, its WebSocket form and the attachments host (presigned URLs
//     live on the same hostname, default port): the UI is on its own local origin, so 'self' covers
//     only the packaged assets;
//   - img-src and media-src name the attachments host too: the full-size photo and the video are shown
//     straight from their presigned URL (a video is streamed, it is not downloaded whole into a blob);
//   - no inline script exists in this build (no service-worker registration), so script-src carries
//     no hash; frame-ancestors is dropped because a <meta> policy cannot express it.

/** The origins the packaged UI may connect to, derived from VITE_API_ORIGIN. */
export function appConnectSources(apiOrigin: string): string[] {
    const u = new URL(apiOrigin);
    if (u.protocol !== "https:" && u.hostname !== "localhost") {
        throw new Error(`VITE_API_ORIGIN must be https: ${apiOrigin}`);
    }
    const ws = `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}`;
    const attachments = `${u.protocol}//${u.hostname}`;
    return [...new Set([u.origin, ws, attachments])];
}

/** Where presigned attachment URLs live: the API hostname on the default port. */
export function appAttachmentsSource(apiOrigin: string): string {
    const u = new URL(apiOrigin);
    return `${u.protocol}//${u.hostname}`;
}

export function appCsp(apiOrigin: string): string {
    const attachments = appAttachmentsSource(apiOrigin);
    return [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        `img-src 'self' data: blob: ${attachments}`,
        `media-src 'self' blob: ${attachments}`,
        "font-src 'self' data:",
        `connect-src 'self' ${appConnectSources(apiOrigin).join(" ")}`,
        "worker-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
    ].join("; ");
}

export const CSP_META = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?>/;

/** index.html with the policy as the first element of <head>, before anything that loads. */
export function withCspMeta(html: string, csp: string): string {
    if (CSP_META.test(html)) throw new Error("index.html already carries a CSP meta");
    if (!/<head>/.test(html)) throw new Error("index.html has no <head>");
    if (/<script(?![^>]*\ssrc=)[^>]*>\s*\S/.test(html)) {
        throw new Error("the app build must have no inline script: the policy would block it");
    }
    return html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
}
