import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RolldownPluginOption } from "rolldown";
import { afterAll, describe, expect, it } from "vitest";

import { buildSingleRolldownChunk } from "#internal/bundler/rolldown.js";
import { createExtensionMountPlugin } from "#internal/bundler/extension-mount-plugin.js";
import {
  createExtensionScopePlugin,
  createFixedMountScopePlugin,
} from "#internal/bundler/extension-scope-plugin.js";

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

async function bundle(input: string, plugins: RolldownPluginOption[]): Promise<string> {
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

  it("binds an application import to the application's mount over another extension's nested mount", async () => {
    const { sourceRoot } = scratchModule("export const value = 1;");
    const { sourceRoot: hostRoot } = scratchModule("export const host = 1;");
    const entry = join(sourceRoot, "..", "consumer.ts");
    writeFileSync(entry, 'export { value } from "./extension/tools/budget.ts";');
    const code = await bundle(entry, [
      createExtensionMountPlugin([
        {
          mountId: "extensions/code",
          sourceRoot,
          packageName: "@acme/code",
          specifier: "@acme/code",
        },
        {
          mountId: "extensions/host",
          sourceRoot: hostRoot,
          packageName: "@acme/host",
          specifier: "@acme/host",
        },
        {
          mountId: "extensions/host/subagents/worker/extensions/code",
          sourceRoot,
          packageName: "@acme/code",
          specifier: "@acme/code",
        },
      ]),
    ]);
    expect((await import(`data:text/javascript,${encodeURIComponent(code)}`)).value).toBe(1);
  });

  afterAll(() => {});

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
    const plugins = [createExtensionScopePlugin([]), externalizeEvePlugin].filter(
      (plugin) => plugin !== null,
    );
    const code = await bundle(modulePath, plugins);
    expect(code).not.toContain("eve/internal/mount-state");
    void sourceRoot;
  });

  it("binds package-specifier handle imports independently across duplicate mounts when bindHandles is enabled", async () => {
    const { sourceRoot } = scratchModule('import ext from "dup-ext"; export const tag = ext.tag;');
    const dir = join(sourceRoot, "..");
    const pkgRoot = join(dir, "node_modules", "dup-ext");
    const distExt = join(pkgRoot, "dist", "extension");
    mkdirSync(join(distExt, "tools"), { recursive: true });
    writeFileSync(
      join(pkgRoot, "package.json"),
      JSON.stringify({ name: "dup-ext", type: "module", exports: { ".": "./dist/index.mjs" } }),
    );
    writeFileSync(
      join(pkgRoot, "dist", "index.mjs"),
      'export { default } from "./extension/extension.mjs";',
    );
    writeFileSync(
      join(distExt, "extension.mjs"),
      "let bound; const h = (v) => { bound = v; }; Object.defineProperty(h, 'tag', { get: () => bound?.tag }); export default h;",
    );
    writeFileSync(
      join(distExt, "tools", "read.mjs"),
      'import ext from "dup-ext"; export const tag = ext.tag;',
    );
    const alphaMount = join(dir, "alpha.mjs");
    const betaMount = join(dir, "beta.mjs");
    writeFileSync(alphaMount, 'import ext from "dup-ext"; export default ext({ tag: "alpha" });');
    writeFileSync(betaMount, 'import ext from "dup-ext"; export default ext({ tag: "beta" });');
    const entry = join(dir, "entry.mjs");
    writeFileSync(
      entry,
      [
        `export { tag as alpha } from ${JSON.stringify(join(distExt, "tools", "read.mjs") + "?eve-mount=extensions%2Falpha")};`,
        `export { tag as beta } from ${JSON.stringify(join(distExt, "tools", "read.mjs") + "?eve-mount=extensions%2Fbeta")};`,
      ].join("\n"),
    );
    const code = await bundle(entry, [
      createExtensionMountPlugin(
        [
          {
            mountId: "extensions/alpha",
            mountSourcePath: alphaMount,
            packageName: "dup-ext",
            sourceRoot: distExt,
            specifier: "dup-ext",
          },
          {
            mountId: "extensions/beta",
            mountSourcePath: betaMount,
            packageName: "dup-ext",
            sourceRoot: distExt,
            specifier: "dup-ext",
          },
        ],
        new Map(),
        { bindHandles: true },
      ),
    ]);
    const result = (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as {
      alpha: string;
      beta: string;
    };
    expect({ alpha: result.alpha, beta: result.beta }).toEqual({ alpha: "alpha", beta: "beta" });
  });

  it("bakes the namespace via the fixed-namespace (dev per-module) plugin", async () => {
    const { modulePath } = scratchModule(STATE_MODULE);
    const code = await bundle(modulePath, [
      createFixedMountScopePlugin("extensions/crm"),
      externalizeEvePlugin,
    ]);
    expect(code).toContain('defineMountedState("extensions/crm", name, initial)');
  });
});
