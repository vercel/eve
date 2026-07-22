import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildSingleRolldownChunk } from "#internal/bundler/nitro-rolldown.js";

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
