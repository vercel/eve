import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { buildSingleRolldownChunk } from "#internal/bundler/nitro-rolldown.js";
import {
  createExtensionScopePlugin,
  createFixedNamespaceScopePlugin,
} from "#internal/bundler/extension-scope-plugin.js";

// Externalizes the framework barrels so the temp module bundles without eve
// installed in the scratch dir — mirrors how the real loader treats them.
const externalizeEvePlugin = {
  name: "test-externalize-eve",
  resolveId(source: string) {
    return source.startsWith("eve/") ? { id: source, external: true } : undefined;
  },
};

const roots: string[] = [];

function scratchModule(source: string): { modulePath: string; sourceRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), "eve-ext-scope-"));
  roots.push(dir);
  const sourceRoot = join(dir, "extension");
  mkdirSync(join(sourceRoot, "tools"), { recursive: true });
  const modulePath = join(sourceRoot, "tools", "budget.ts");
  writeFileSync(modulePath, source, "utf8");
  return { modulePath, sourceRoot };
}

async function bundle(input: string, plugins: unknown[]): Promise<string> {
  const chunk = await buildSingleRolldownChunk("test module", {
    input,
    platform: "node",
    plugins,
    resolve: { extensions: [".ts", ".js", ".mjs"] },
    output: { comments: false, format: "esm" },
  });
  return chunk.code;
}

const STATE_MODULE = [
  'import { defineState } from "eve/context";',
  'export const budget = defineState("budget", () => ({ count: 0 }));',
  "",
].join("\n");

describe("extension-scope plugin (bundled)", () => {
  afterAll(() => {
    // Scratch dirs live under the OS temp root; leaving them is harmless and
    // avoids racing the bundler's async file handles on cleanup.
  });

  it("bakes the package namespace into an extension-owned module's defineState", async () => {
    const { modulePath, sourceRoot } = scratchModule(STATE_MODULE);
    const code = await bundle(modulePath, [
      createExtensionScopePlugin([{ sourceRoot, packageNamespace: "acme-crm" }]),
      externalizeEvePlugin,
    ]);
    expect(code).toContain("acme-crm");
    expect(code).toContain("eve/context");
  });

  it("leaves a module outside every extension source root unscoped", async () => {
    const { modulePath } = scratchModule(STATE_MODULE);
    const code = await bundle(modulePath, [
      createExtensionScopePlugin([
        {
          sourceRoot: join(tmpdir(), "some-other-extension", "extension"),
          packageNamespace: "acme-crm",
        },
      ]),
      externalizeEvePlugin,
    ]);
    expect(code).not.toContain("acme-crm");
  });

  it("does not scope when there are no extensions", async () => {
    const { modulePath, sourceRoot } = scratchModule(STATE_MODULE);
    // createExtensionScopePlugin returns null for an empty scope set; filter it.
    const plugins = [createExtensionScopePlugin([]), externalizeEvePlugin].filter(
      (plugin) => plugin !== null,
    );
    const code = await bundle(modulePath, plugins);
    expect(code).not.toContain("acme-crm");
    void sourceRoot;
  });

  it("bakes the namespace via the fixed-namespace (dev per-module) plugin", async () => {
    // The dev loader path: the plugin is handed the namespace directly, with no
    // filesystem matching (which is unreliable under workspace symlinks).
    const { modulePath } = scratchModule(STATE_MODULE);
    const code = await bundle(modulePath, [
      createFixedNamespaceScopePlugin("acme-crm"),
      externalizeEvePlugin,
    ]);
    expect(code).toContain("acme-crm");
  });
});
