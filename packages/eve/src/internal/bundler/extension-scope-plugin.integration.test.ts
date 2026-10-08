import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { buildSingleRolldownChunk } from "#internal/bundler/nitro-rolldown.js";
import { createExtensionMountPlugin } from "#internal/bundler/extension-mount-plugin.js";
import {
  createExtensionScopePlugin,
  createFixedMountScopePlugin,
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
  it("evaluates shared extension source once per mount, including relative imports", async () => {
    const { sourceRoot } = scratchModule('export { instance } from "../shared.ts";');
    writeFileSync(join(sourceRoot, "shared.ts"), "export const instance = {};");
    const entry = join(sourceRoot, "entry.ts");
    writeFileSync(
      entry,
      [
        'import { instance as research } from "./tools/budget.ts?eve-mount=extensions%2Fresearch";',
        'import { instance as support } from "./tools/budget.ts?eve-mount=extensions%2Fsupport";',
        "export const distinct = research !== support;",
      ].join("\n"),
    );
    const code = await bundle(entry, [
      createExtensionMountPlugin([
        {
          mountId: "extensions/research",
          sourceRoot,
          packageName: "@acme/test",
          specifier: "@acme/test",
        },
        {
          mountId: "extensions/support",
          sourceRoot,
          packageName: "@acme/test",
          specifier: "@acme/test",
        },
      ]),
    ]);
    const result = (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as {
      distinct: boolean;
    };
    expect(result.distinct).toBe(true);
  });
  it.each(["dual", "import-only"])(
    "uses the ESM export for a mounted %s package",
    async (shape) => {
      const { sourceRoot } = scratchModule("export const value = 1;");
      const dir = join(sourceRoot, "..");
      const packageRoot = join(dir, "node_modules", "test-extension");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "test-extension",
          exports: {
            ".":
              shape === "dual"
                ? { import: "./entry.mjs", require: "./entry.cjs" }
                : { import: "./entry.mjs" },
          },
        }),
      );
      writeFileSync(join(packageRoot, "entry.mjs"), 'export const format = "esm";');
      writeFileSync(join(packageRoot, "entry.cjs"), 'exports.format = "cjs";');
      const entry = join(dir, "consumer.ts");
      writeFileSync(entry, 'export { format } from "test-extension?eve-mount=extensions%2Ftest";');
      const code = await bundle(entry, [
        createExtensionMountPlugin([
          {
            mountId: "extensions/test",
            sourceRoot: packageRoot,
            packageName: "test-extension",
            specifier: "test-extension",
          },
        ]),
      ]);
      expect((await import(`data:text/javascript,${encodeURIComponent(code)}`)).format).toBe("esm");
    },
  );

  it("rejects an application import with two possible mount owners", async () => {
    const { sourceRoot } = scratchModule("export const value = 1;");
    const entry = join(sourceRoot, "..", "consumer.ts");
    writeFileSync(entry, 'export { value } from "./extension/tools/budget.ts";');
    await expect(
      bundle(entry, [
        createExtensionMountPlugin([
          {
            mountId: "extensions/research",
            sourceRoot,
            packageName: "@acme/test",
            specifier: "@acme/test",
          },
          {
            mountId: "extensions/support",
            sourceRoot,
            packageName: "@acme/test",
            specifier: "@acme/test",
          },
        ]),
      ]),
    ).rejects.toThrow(/multiple extension mounts/);
  });

  afterAll(() => {
    // Scratch dirs live under the OS temp root; leaving them is harmless and
    // avoids racing the bundler's async file handles on cleanup.
  });

  it("bakes the package namespace into an extension-owned module's defineState", async () => {
    const { modulePath, sourceRoot } = scratchModule(STATE_MODULE);
    const code = await bundle(modulePath, [
      createExtensionScopePlugin([{ sourceRoot, mountId: "extensions/crm" }]),
      externalizeEvePlugin,
    ]);
    expect(code).toContain('defineMountedState("extensions/crm", name, initial)');
    expect(code).toContain("eve/internal/mount-state");
  });

  it("leaves a module outside every extension source root unscoped", async () => {
    const { modulePath } = scratchModule(STATE_MODULE);
    const code = await bundle(modulePath, [
      createExtensionScopePlugin([
        {
          sourceRoot: join(tmpdir(), "some-other-extension", "extension"),
          mountId: "extensions/crm",
        },
      ]),
      externalizeEvePlugin,
    ]);
    expect(code).not.toContain("eve/internal/mount-state");
  });

  it("does not scope when there are no extensions", async () => {
    const { modulePath, sourceRoot } = scratchModule(STATE_MODULE);
    // createExtensionScopePlugin returns null for an empty scope set; filter it.
    const plugins = [createExtensionScopePlugin([]), externalizeEvePlugin].filter(
      (plugin) => plugin !== null,
    );
    const code = await bundle(modulePath, plugins);
    expect(code).not.toContain("eve/internal/mount-state");
    void sourceRoot;
  });

  it("bakes the namespace via the fixed-namespace (dev per-module) plugin", async () => {
    // The dev loader path: the plugin is handed the namespace directly, with no
    // filesystem matching (which is unreliable under workspace symlinks).
    const { modulePath } = scratchModule(STATE_MODULE);
    const code = await bundle(modulePath, [
      createFixedMountScopePlugin("extensions/crm"),
      externalizeEvePlugin,
    ]);
    expect(code).toContain('defineMountedState("extensions/crm", name, initial)');
  });
});
