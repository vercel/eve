import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildSingleRolldownChunk,
  buildWithNitroRolldown,
} from "#internal/bundler/nitro-rolldown.js";

function scratchModuleWithDynamicImport(): string {
  const dir = mkdtempSync(join(tmpdir(), "eve-single-chunk-"));
  writeFileSync(
    join(dir, "lazy.ts"),
    'export const LAZY_MARKER = "eve-lazy-module-marker";\n',
    "utf8",
  );
  const entryPath = join(dir, "entry.ts");
  writeFileSync(
    entryPath,
    'export async function loadLazy(): Promise<string> {\n  const { LAZY_MARKER } = await import("./lazy");\n  return LAZY_MARKER;\n}\n',
    "utf8",
  );
  return entryPath;
}

describe("buildSingleRolldownChunk", () => {
  it("rejects standard condition names that override per-edge resolution", async () => {
    await expect(
      buildWithNitroRolldown({
        input: "entry.js",
        resolve: { conditionNames: ["eve-source", "import"] },
      }),
    ).rejects.toThrow('standard condition "import"');
  });

  it("preserves require conditions inside bundled CommonJS dependencies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eve-rolldown-conditions-"));
    const parentRoot = join(dir, "node_modules", "cjs-parent");
    const baseRoot = join(dir, "node_modules", "conditional-base");
    const entryPath = join(dir, "entry.mjs");
    const bundlePath = join(dir, "bundle.mjs");

    try {
      mkdirSync(parentRoot, { recursive: true });
      mkdirSync(baseRoot, { recursive: true });
      writeFileSync(
        entryPath,
        'import Child from "cjs-parent";\nimport imported from "conditional-base";\nexport const sources = [new Child().source, imported.source];\n',
      );
      writeFileSync(
        join(parentRoot, "index.cjs"),
        'const Base = require("conditional-base");\nmodule.exports = class Child extends Base {};\n',
      );
      writeFileSync(
        join(parentRoot, "package.json"),
        `${JSON.stringify({ main: "./index.cjs", name: "cjs-parent", version: "1.0.0" })}\n`,
      );
      writeFileSync(join(baseRoot, "import.mjs"), 'export default { source: "import" };\n');
      writeFileSync(
        join(baseRoot, "require.cjs"),
        'module.exports = class Base { constructor() { this.source = "require"; } };\n',
      );
      writeFileSync(
        join(baseRoot, "package.json"),
        `${JSON.stringify({
          exports: { ".": { import: "./import.mjs", require: "./require.cjs" } },
          name: "conditional-base",
          type: "module",
          version: "1.0.0",
        })}\n`,
      );

      const chunk = await buildSingleRolldownChunk("conditional exports fixture", {
        cwd: dir,
        input: entryPath,
        platform: "node",
        resolve: { mainFields: ["module", "main"] },
        output: { comments: false, format: "esm" },
      });
      writeFileSync(bundlePath, chunk.code);

      const bundle = (await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`)) as {
        readonly sources: readonly string[];
      };
      expect(bundle.sources).toEqual(["require", "import"]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("inlines dynamic imports into one chunk instead of splitting", async () => {
    const entryPath = scratchModuleWithDynamicImport();

    const chunk = await buildSingleRolldownChunk("test module", {
      input: entryPath,
      platform: "node",
      resolve: { extensions: [".ts", ".js", ".mjs"] },
      output: { comments: false, format: "esm" },
    });

    expect(chunk.code).toContain("eve-lazy-module-marker");
  });

  it("does not let callers re-enable code splitting through output options", async () => {
    const entryPath = scratchModuleWithDynamicImport();

    const chunk = await buildSingleRolldownChunk("test module", {
      input: entryPath,
      platform: "node",
      resolve: { extensions: [".ts", ".js", ".mjs"] },
      output: { codeSplitting: true, comments: false, format: "esm" },
    });

    expect(chunk.code).toContain("eve-lazy-module-marker");
  });
});
