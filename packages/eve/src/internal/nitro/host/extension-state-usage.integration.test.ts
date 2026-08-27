import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { extensionUsesState } from "#internal/nitro/host/extension-state-usage.js";

async function createSourceTree(files: Record<string, string>): Promise<string> {
  const sourceRoot = await mkdtemp(join(tmpdir(), "eve-state-usage-"));
  for (const [logicalPath, content] of Object.entries(files)) {
    const path = join(sourceRoot, logicalPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  return sourceRoot;
}

describe("extensionUsesState", () => {
  it("detects a direct aliased import", async () => {
    const sourceRoot = await createSourceTree({
      "lib/budget.ts": [
        'import { defineState as state } from "eve/context";',
        'export const budget = state("budget", () => 1);',
        "",
      ].join("\n"),
    });
    await expect(extensionUsesState(sourceRoot)).resolves.toBe(true);
  });

  it("detects usage through a local re-export barrel", async () => {
    const sourceRoot = await createSourceTree({
      "lib/eve.ts": 'export { defineState } from "eve/context";\n',
      "tools/budget.ts": [
        'import { defineState } from "../lib/eve";',
        'export const budget = defineState("budget", () => 1);',
        "",
      ].join("\n"),
    });
    await expect(extensionUsesState(sourceRoot)).resolves.toBe(true);
  });

  it("detects usage through an aliased multi-hop barrel chain", async () => {
    const sourceRoot = await createSourceTree({
      "lib/deep.ts": 'export { defineState as state } from "eve/context";\n',
      "lib/eve.ts": 'export { state } from "./deep";\n',
      "tools/budget.ts": [
        'import { state } from "../lib/eve";',
        'export const budget = state("budget", () => 1);',
        "",
      ].join("\n"),
    });
    await expect(extensionUsesState(sourceRoot)).resolves.toBe(true);
  });

  it("detects usage through an `export *` barrel and a namespace import", async () => {
    const sourceRoot = await createSourceTree({
      "lib/eve.ts": 'export * from "eve/context";\n',
      "tools/budget.ts": [
        'import * as ctx from "../lib/eve";',
        'export const budget = ctx.defineState("budget", () => 1);',
        "",
      ].join("\n"),
    });
    await expect(extensionUsesState(sourceRoot)).resolves.toBe(true);
  });

  it("detects an import-then-re-export barrel", async () => {
    const sourceRoot = await createSourceTree({
      "lib/eve.ts": [
        'import { defineState } from "eve/context";',
        "export { defineState as state };",
        "",
      ].join("\n"),
      "tools/budget.ts": [
        'import { state } from "../lib/eve.js";',
        'export const budget = state("budget", () => 1);',
        "",
      ].join("\n"),
    });
    await expect(extensionUsesState(sourceRoot)).resolves.toBe(true);
  });

  it("ignores an imported defineState that is never called", async () => {
    const sourceRoot = await createSourceTree({
      "lib/eve.ts": 'export { defineState } from "eve/context";\n',
      "tools/idle.ts": [
        'import { defineState } from "../lib/eve";',
        "export const unused = defineState;",
        "",
      ].join("\n"),
    });
    await expect(extensionUsesState(sourceRoot)).resolves.toBe(false);
  });

  it("ignores an unrelated local function named defineState", async () => {
    const sourceRoot = await createSourceTree({
      "tools/local.ts": [
        "const defineState = (name: string) => name;",
        'export const value = defineState("not-eve-state");',
        "",
      ].join("\n"),
    });
    await expect(extensionUsesState(sourceRoot)).resolves.toBe(false);
  });

  it("returns false for a tree without state", async () => {
    const sourceRoot = await createSourceTree({
      "extension.ts":
        'import { defineExtension } from "eve/extension";\nexport default defineExtension();\n',
    });
    await expect(extensionUsesState(sourceRoot)).resolves.toBe(false);
  });
});
