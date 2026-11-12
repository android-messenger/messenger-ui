// Minimal zero-dependency static server for the built SPA.
// Runs under Node on port 5555 behind the same Ory edge as the messenger
// (same origin → the Kratos cookie applies).
//
//   npm ci && npm run build      # produces ./dist
//   PORT=5555 node server.mjs    # serves ./dist, SPA-fallback to index.html
//
// The app calls the messenger host-relative (/messenger/api, /messenger/ws) and Kratos
// at /.ory/kratos/public, so the edge must route those paths and this app's "/" to :5555.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const DIST = join(fileURLToPath(new URL(".", import.meta.url)), "dist");
const PORT = Number(process.env.PORT) || 5555;
const HOST = process.env.HOST || "0.0.0.0";

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".wasm": "application/wasm",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
};

// Cache policy is critical for a PWA behind a CDN (Cloudflare):
//  - sw.js / the workbox runtime / index.html / manifest MUST NOT be cached, or a stale service
//    worker keeps precaching an OLD build whose chunk hashes no longer match the fresh index.html
//    → the app loads new HTML but the SW serves old chunks → runtime crashes. Serve them no-store.
//  - Content-hashed assets (/assets/*, hashed filenames) are immutable → cache them hard.
function cacheControlFor(path) {
    const base = path.split(/[/\\]/).pop() || "";
    // The service worker (any *sw.js — we use app-sw.js) and its workbox runtime must NEVER be
    // CDN-cached, or a stale SW pins an old precache manifest → chunk-hash mismatch → app crash.
    if (base.endsWith("sw.js") || base.startsWith("workbox-")) return "no-store, no-cache, must-revalidate";
    const ext = extname(path);
    if (ext === ".html") return "no-store, no-cache, must-revalidate";
    if (ext === ".webmanifest") return "no-cache";
    if (path.includes(`${"/"}assets${"/"}`)) return "public, max-age=31536000, immutable";
    return "no-cache";
}

// E2EE hardening (Phase 0): a strict, ENFORCING CSP so the app runs only OUR code — a page tricked
// into loading attacker JS could read E2EE keys. Everything the app talks to is same-origin (the edge
// routes /messenger, /.ory, /webpush and the presigned attachment URLs under this host), confirmed by a
// report-only pass showing zero cross-origin violations → 'self' covers REST, WS and attachment fetch.
// WebRTC ICE/TURN isn't governed by CSP. Notes on the two allowances beyond 'self':
//   - 'wasm-unsafe-eval': the jSquash WebP encoder (image compression) compiles WASM; this permits WASM
//     compilation WITHOUT permitting string eval (far narrower than 'unsafe-eval'). If a browser rejects
//     it, imageCompress falls back to canvas — no functional loss.
//   - script hash: the one inline script is VitePWA's SW registration. We hash it FROM the very
//     index.html we serve (below), so the hash always matches this build and survives SW precaching —
//     no brittle hardcoded/nonce coupling.
//   - style 'unsafe-inline': React inline style ATTRIBUTES (progress bars etc.); not a code-exec vector.
let cspCache = null;
async function cspHeader() {
    if (cspCache) return cspCache;
    let hashes = "";
    try {
        const html = await readFile(join(DIST, "index.html"), "utf8");
        const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;
        const hs = [];
        let m;
        while ((m = re.exec(html))) {
            if (m[1].trim()) hs.push(`'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
        }
        hashes = hs.join(" ");
    } catch { /* no inline scripts → 'self' only */ }
    cspCache = [
        "default-src 'self'",
        `script-src 'self' 'wasm-unsafe-eval' ${hashes}`.trim(),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "worker-src 'self'",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'self'",
    ].join("; ");
    return cspCache;
}

async function sendFile(res, path) {
    const body = await readFile(path);
    const headers = {
        "Content-Type": MIME[extname(path)] || "application/octet-stream",
        "Cache-Control": cacheControlFor(path),
    };
    // CSP governs the document; set the enforcing policy on the HTML shell.
    if (extname(path) === ".html") headers["Content-Security-Policy"] = await cspHeader();
    res.writeHead(200, headers);
    res.end(body);
}

const server = createServer(async (req, res) => {
    try {
        const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
        // Contain the path within DIST (no traversal).
        const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
        const candidate = join(DIST, rel);

        if (candidate.startsWith(DIST)) {
            try {
                const s = await stat(candidate);
                if (s.isFile()) return await sendFile(res, candidate);
            } catch {
                // fall through to SPA fallback
            }
        }
        // SPA fallback: any non-file route renders index.html (client-side routing).
        return await sendFile(res, join(DIST, "index.html"));
    } catch {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal error");
    }
});

server.listen(PORT, HOST, () => {
    console.log(`messenger-ui serving ${DIST} on http://${HOST}:${PORT}`);
});
