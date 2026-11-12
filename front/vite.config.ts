import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { visualizer } from "rollup-plugin-visualizer";
import { VitePWA } from "vite-plugin-pwa";
import pkg from "./package.json" with { type: "json" };
import { readFileSync } from "node:fs";
import { appCsp, CSP_META, withCspMeta } from "./csp.app";


// `--mode app`: the build packaged into the Android APK (docs security/09-ui-in-apk.md). The UI then
// runs on the app's local origin and reaches the APIs at VITE_API_ORIGIN (required); no PWA / service
// worker (the APK is the app shell and its only update channel), served at the root of the assets.
export default defineConfig(({mode, command}) => {
  const app = mode === "app";
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const apiOrigin = env.VITE_API_ORIGIN;
  if (app && !apiOrigin) {
    throw new Error("--mode app needs VITE_API_ORIGIN=https://app.<host>[:port]");
  }
  // The STUN/TURN server has no default in the code: a build must name the server of its own stack.
  if (command === "build" && (!env.VITE_TURN_HOST || !env.VITE_TURN_PORT)) {
    throw new Error("the build needs VITE_TURN_HOST and VITE_TURN_PORT (the STUN/TURN server of this stack)");
  }
  let outDir = "dist-app";
  return {
  base: app ? "/" : undefined,
  // Build-time constants surfaced in the app (the diagnostics/info page shows them).
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
      react(),
      tailwindcss(),
      // Installable PWA (web build only) (home-screen install + offline app shell). scope/start_url derive from the
      // build `base` (--base=/messenger-ui/). autoUpdate so frequent redeploys don't leave a device
      // stuck on a stale cached bundle.
      !app && VitePWA({
        registerType: "autoUpdate",
        // CDN-cache trap recovery: Cloudflare had cached BOTH the old `sw.js` AND `registerSW.js`
        // (stale precache manifest → chunk-hash mismatch → app crash) and they couldn't be purged.
        // Two changes sidestep the CDN entirely:
        //  - filename: a fresh SW URL the CDN never cached (served no-store so it never gets cached);
        //  - injectRegister "inline": the SW registration lives INLINE in index.html (which the CDN
        //    does not cache — DYNAMIC), so there is no cacheable registerSW.js bootstrap to go stale.
        filename: "app-sw.js",
        injectRegister: "inline",
        manifest: {
          name: "Wolp Messenger",
          short_name: "Wolp",
          description: "Wolp Messenger",
          theme_color: "#134e4a",
          background_color: "#134e4a",
          display: "standalone",
          orientation: "portrait",
          icons: [
            { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
            { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
            { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,png,svg,woff2}"],
          cleanupOutdatedCaches: true,
          // Pull the Web Push handlers (push / notificationclick) into the generated SW. They live in
          // /public as plain JS (served verbatim, not precached under a hashed name), so notifications
          // work when the app is closed/backgrounded — the one thing the page JS can't do while the OS
          // has suspended the tab. Keeps generateSW (precaching) instead of switching to injectManifest.
          importScripts: ["push-sw.js"],
          // Chat/IDS/Kratos APIs are outside the SW scope (/messenger-ui/) → never intercepted;
          // only the app shell is precached.
          //
          // MUST be set explicitly: vite-plugin-pwa only auto-enables these for injectRegister
          // "auto"/null, and we use "inline" (to dodge CDN-cached registerSW.js). Without them the
          // freshly-deployed SW installs but sits in "waiting" forever while any tab/PWA stays open,
          // the old SW keeps serving the stale precached bundle, and main.tsx's controllerchange
          // reload never fires — devices get stuck on old builds until fully closed. With them the
          // new SW activates + claims immediately → controllerchange → one clean reload to the new build.
          skipWaiting: true,
          clientsClaim: true,
        },
      }),
      // The packaged UI carries its Content-Security-Policy inside index.html (csp.app.ts). The build
      // fails if the finished index.html ends up without it.
      app && {
        name: "wolp-app-csp",
        configResolved(c: { build: { outDir: string }; root: string }) { outDir = path.resolve(c.root, c.build.outDir); },
        transformIndexHtml: { order: "post" as const, handler: (html: string) => withCspMeta(html, appCsp(apiOrigin)) },
        closeBundle() {
          if (!CSP_META.test(readFileSync(path.join(outDir, "index.html"), "utf8"))) {
            throw new Error("app build: index.html has no Content-Security-Policy meta");
          }
        },
      },
      !app && visualizer({
        open: true,
        gzipSize: true,
        brotliSize: true
      })
    ],
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("@ory/client")) return "ory";
            if (id.includes("react")) return "react";
          }
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
};
});
