import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Tests that read the sources as text (no raw NUL bytes, renamed stores, the scenario table of spec 003)
// import `virtual:repo-text`. They must not import the files with `?raw`: the coverage then takes every
// such file for a loaded module with no statements, and a file no test runs counts as fully covered.
function repoText(): Plugin {
    const root = import.meta.dirname;
    const read = (dir: string, ext: RegExp, base: string) => {
        const out: Record<string, string> = {};
        for (const e of readdirSync(dir, {recursive: true, withFileTypes: true})) {
            if (!e.isFile() || !ext.test(e.name)) continue;
            const file = join(e.parentPath, e.name);
            out["/" + relative(base, file).split(sep).join("/")] = readFileSync(file, "utf8");
        }
        return out;
    };
    return {
        name: "repo-text",
        resolveId: (id) => (id === "virtual:repo-text" ? "\0virtual:repo-text" : null),
        load(id) {
            if (id !== "\0virtual:repo-text") return null;
            const sources = read(join(root, "src"), /\.(ts|tsx|css)$/, root);
            const specs = read(join(root, "..", "specs"), /\.md$/, join(root, ".."));
            const build = {
                "/package.json": readFileSync(join(root, "package.json"), "utf8"),
                "/vitest.config.ts": readFileSync(join(root, "vitest.config.ts"), "utf8"),
                "/.github/workflows/ci.yml": readFileSync(join(root, "..", ".github", "workflows", "ci.yml"), "utf8"),
            };
            return ["sources", "specs", "build"].map((name, i) => `export const ${name} = ${JSON.stringify([sources, specs, build][i])};`).join("\n");
        },
    };
}

// The files of the message path (spec 003, T301): what a message goes through between the socket, the
// store, the disk and the screen. The ONE list: coverage is measured over it and the threshold is held on
// it. A file leaves the list only with a reason written in the pull request (FR-004).
export const MESSAGE_PATH = [
    "src/infrastructure/middleware/wsMiddleware.ts",
    "src/infrastructure/slices/websocketSlice.ts",
    "src/infrastructure/ws/frameBridge.ts",
    "src/features/chat/middleware/chatMiddleware.ts",
    "src/features/chat/rest/chatApi.ts",
    "src/features/chat/thunk/*.ts",
    "src/features/chat/model/services/chatMessages.service.ts",
    "src/features/chat/model/historySync.ts",
    "src/features/chat/model/mergeHistory.ts",
    "src/features/chat/model/unreadProbe.ts",
    "src/features/chat/model/historyCache.ts",
    "src/features/chat/model/reconcileHistory.ts",
    "src/features/chat/model/mapper.ts",
    "src/features/chat/model/sealedLists.ts",
    "src/features/chat/model/drafts.ts",
    "src/features/chat/model/slices/outboxSlice.ts",
    "src/features/chat/model/slices/chatUiSlice.ts",
    "src/features/chat/hooks/useReconnectCatchup.ts",
    "src/features/chat/hooks/useOutboxRetry.ts",
    "src/features/chat/hooks/useOutboxStatus.ts",
    "src/features/chat/hooks/useMessageComposer.ts",
    "src/features/chat/hooks/useChatMessages.ts",
    "src/features/chat/hooks/useChatAttachments.ts",
    "src/features/chat/hooks/useReadReceipts.ts",
    "src/features/chat/hooks/useWindowedHistory.ts",
    "src/features/chat/db/db.ts",
    "src/features/chat/db/sealed.ts",
    "src/store/store.ts",
    "src/store/logout.ts",
    "src/features/auth/middleware/authErrorMiddleware.ts",
    "src/features/auth/model/enterSession.ts",
    "src/infrastructure/native/NativeAppBridge.tsx",
    "src/infrastructure/native/appLifecycle.ts",
];

export default defineConfig({
    plugins: [tsconfigPaths(), repoText()],
    test: {
        globals: true,
        environment: "jsdom",
        include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
        setupFiles: ["src/testSetup.ts"],
        coverage: {
            provider: "v8",
            include: MESSAGE_PATH,
            reporter: ["text", "json-summary"],
            reportsDirectory: "coverage",
            // The check fails below these (FR-004). They are what the tests reach today, rounded down, and
            // only go up: every pull request of spec 003 raises them to what it reaches, and T376 sets the
            // target — lines 90, branches 80. Lowering a number to get a green check is not allowed.
            thresholds: {lines: 80, branches: 70},
        },
    },
});
