import {describe, it, expect} from "vitest";
import {sources, specs, build} from "virtual:repo-text";

// Spec 003, scenarios 1.3 and 1.4 (FR-003, FR-004): the table "scenario → test" is kept true by a test,
// and the coverage threshold is part of the check that guards `main`.

const SPEC = "/specs/003-message-path/";

/** The cells of every table row of a markdown text. */
const rows = (md: string) => md.split("\n").filter((l) => l.startsWith("|")).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));

/** Stories marked merged in the "Состояние" table of tasks.md: "1", "2", … */
const mergedStories = new Set(
    rows(specs[SPEC + "tasks.md"])
        .filter((r) => /^\d+\. /.test(r[0]) && /^слита/.test(r[2] ?? ""))
        .map((r) => r[0].split(".")[0]),
);

/** Scenario → the cell "Тест" of its row in test-matrix.md. */
const matrix = new Map(rows(specs[SPEC + "test-matrix.md"]).filter((r) => /^\d+\.\d+$/.test(r[0])).map((r) => [r[0], r[4] ?? ""]));

/** Scenario → the test files in src/__path__ that have a test named with its number. */
const tests = new Map<string, string[]>();
for (const [path, text] of Object.entries(sources)) {
    if (!/^\/src\/__path__\/.*\.test\.tsx?$/.test(path)) continue;
    for (const m of text.matchAll(/\b(?:it|test|describe)(?:\.\w+)*\(\s*[`"'](\d+\.\d+):/g)) {
        const files = tests.get(m[1]) ?? [];
        if (!files.includes(path)) files.push(path);
        tests.set(m[1], files);
    }
}
const fileName = (path: string) => path.split("/").pop()!;

describe("the table of scenarios and the coverage threshold", () => {
    it("1.4: the table and the tests are found", () => {
        expect(matrix.size).toBe(37);
        expect(tests.size).toBeGreaterThan(0);
        expect(mergedStories.has("1")).toBe(true);
    });

    it("1.4: every scenario of a merged story has a test named with its number, and the table names the file", () => {
        const missing = [...matrix.keys()]
            .filter((scenario) => mergedStories.has(scenario.split(".")[0]))
            .filter((scenario) => !(tests.get(scenario) ?? []).some((file) => matrix.get(scenario)!.includes(fileName(file))));
        expect(missing).toEqual([]);
    });

    it("1.4: every test named with a scenario number has a row in the table, and a filled cell names a file that has the test", () => {
        expect([...tests.keys()].filter((scenario) => !matrix.has(scenario))).toEqual([]);
        const wrong = [...matrix].filter(([scenario, cell]) =>
            cell !== "" && !(tests.get(scenario) ?? []).some((file) => cell.includes(fileName(file))));
        expect(wrong).toEqual([]);
    });

    it("1.3: the check of a pull request measures the coverage of the message path and fails below the threshold", () => {
        const scripts = (JSON.parse(build["/package.json"]) as {scripts: Record<string, string>}).scripts;
        expect(scripts["test:cov"]).toMatch(/vitest run .*--coverage/);
        expect(scripts.ci).toContain("npm run test:cov");
        expect(scripts.ci).not.toMatch(/npm run test(?!:cov)/);                  // tests run once, with the coverage
        expect(build["/.github/workflows/ci.yml"]).toMatch(/run: npm run ci\b/);

        const config = build["/vitest.config.ts"];
        const threshold = (name: string) => Number(new RegExp(`thresholds:\\s*{[^}]*\\b${name}:\\s*([\\d.]+)`).exec(config)?.[1]);
        expect(threshold("lines")).toBeGreaterThanOrEqual(79);                   // measured on main before the work (T300)
        expect(threshold("branches")).toBeGreaterThanOrEqual(69);
        expect(config).toMatch(/include:\s*MESSAGE_PATH/);
        for (const file of ["chatMiddleware.ts", "chatApi.ts", "wsMiddleware.ts", "outboxSlice.ts", "store.ts"]) expect(config).toContain(file);
    });
});
