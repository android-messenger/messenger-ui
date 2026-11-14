// The sources and the specifications as text, for tests that check them (see repoText in vitest.config.ts).
declare module "virtual:repo-text" {
    /** "/src/…" → the file's text: every .ts, .tsx and .css under front/src. */
    export const sources: Record<string, string>;
    /** "/specs/…" → the file's text: every .md under specs/. */
    export const specs: Record<string, string>;
    /** "/package.json", "/vitest.config.ts" (of front/) and "/.github/workflows/ci.yml". */
    export const build: Record<string, string>;
}
