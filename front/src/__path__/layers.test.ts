// @vitest-environment node
import {describe, it, expect} from "vitest";
import {ESLint} from "eslint";

// Spec 003, scenario 6.3 (FR-051): infrastructure and shared do not import features — the linter of the
// project says so, the same one `npm run lint` runs.

const eslint = new ESLint({cwd: process.cwd()});

/** The messages of the rule on a file with this text at this place of the tree. */
async function restricted(filePath: string, text: string): Promise<string[]> {
    const [result] = await eslint.lintText(text, {filePath});
    return result.messages.filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
}

const IMPORT = `import {historyStale} from "@/features/chat/model/slices/chatHistorySlice.ts";\nexport const x = historyStale;\n`;

describe("the layers", () => {
    it("6.3: an import of a feature in infrastructure or shared fails the linter; in a feature or the app it does not", async () => {
        for (const file of ["src/infrastructure/ws/x.ts", "src/infrastructure/native/x.tsx", "src/shared/utils/x.ts"]) {
            expect(await restricted(file, IMPORT), file).toEqual([expect.stringContaining("FR-051")]);
        }
        expect(await restricted("src/infrastructure/ws/x.ts", `import {historyStale} from "../../features/chat/model/slices/chatHistorySlice.ts";\nexport const x = historyStale;\n`))
            .toEqual([expect.stringContaining("FR-051")]);
        for (const file of ["src/features/native/x.ts", "src/app/x.ts", "src/store/x.ts"]) {
            expect(await restricted(file, IMPORT), file).toEqual([]);
        }
    }, 30_000);
});
