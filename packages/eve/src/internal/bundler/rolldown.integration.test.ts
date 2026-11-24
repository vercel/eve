import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { buildSingleRolldownChunk, buildWithRolldown } from "#internal/bundler/rolldown.js";

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
      buildWithRolldown({
        input: "entry.js",
        resolve: { conditionNames: ["eve-source", "import"] },
      }),
    ).rejects.toThrow('standard condition "import"');
  });

  it("keeps bundle bytes stable across compiler workspace paths", async () => {
    const bundle = async (workspace: string) => {
      const entry = `virtual:${workspace}/module-map.mjs`;
      return await buildSingleRolldownChunk("compiler workspace fixture", {
        input: entry,
        plugins: [
          {
            name: "compiler-workspace-fixture",
            resolveId(id: string) {
              return id === entry ? id : undefined;
            },
            load(id: string) {
              return id === entry ? "export const answer = 42;" : undefined;
            },
          },
        ],
        output: { comments: false, format: "esm" },
      });
    };

    const first = await bundle("first");
    const second = await bundle("second");

    expect(second.code).toBe(first.code);
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

  it("keeps authored and unresolved-import warnings while silencing other dependency warnings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eve-rolldown-dependency-warning-"));
    const dependencyRoot = join(dir, "node_modules", "evaluator");
    const entryPath = join(dir, "entry.mjs");
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });

    try {
      mkdirSync(dependencyRoot, { recursive: true });
      writeFileSync(
        join(dependencyRoot, "package.json"),
        `${JSON.stringify({ main: "./index.js", name: "evaluator", version: "1.0.0" })}\n`,
      );
      writeFileSync(
        join(dependencyRoot, "index.js"),
        'import "eve-missing-package";\nexport const fromDependency = eval("1");\n',
      );
      writeFileSync(
        entryPath,
        'import { fromDependency } from "evaluator";\nexport const values = [fromDependency, eval("2")];\n',
      );

      await buildSingleRolldownChunk("dependency warning fixture", {
        cwd: dir,
        input: entryPath,
        platform: "node",
        output: { format: "esm" },
      });
    } finally {
      warn.mockRestore();
      rmSync(dir, { force: true, recursive: true });
    }

    expect(warnings).toHaveLength(2);
    expect(warnings.find((message) => message.includes("[EVAL]"))).toContain("entry.mjs");
    expect(warnings.find((message) => message.includes("[UNRESOLVED_IMPORT]"))).toContain(
      "eve-missing-package",
    );
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

  it("reports chunks, relative modules, import() chains, and a hint when multiple chunks are emitted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eve-rolldown-multi-chunk-"));
    const srcDir = join(dir, "src");
    const entryPath = join(srcDir, "entry.ts");
    const midPath = join(srcDir, "mid.ts");
    const lazyPath = join(srcDir, "lazy.ts");
    const leafPath = join(srcDir, "leaf.ts");

    try {
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(leafPath, 'export const LEAF_VALUE = "leaf";\n', "utf8");
      writeFileSync(
        lazyPath,
        'import { LEAF_VALUE } from "./leaf";\nexport const LAZY_VALUE = `${LEAF_VALUE}-lazy`;\n',
        "utf8",
      );
      writeFileSync(
        midPath,
        'export async function loadLazy(): Promise<string> {\n  const { LAZY_VALUE } = await import("./lazy");\n  return LAZY_VALUE;\n}\n',
        "utf8",
      );
      writeFileSync(entryPath, 'import { loadLazy } from "./mid";\nexport { loadLazy };\n', "utf8");

      let caught: Error | undefined;
      try {
        await buildSingleRolldownChunk("multi-chunk fixture", {
          cwd: dir,
          input: entryPath,
          platform: "node",
          resolve: { extensions: [".ts", ".js", ".mjs"] },
          plugins: {
            name: "emit-extra-chunk",
            buildStart() {
              this.emitFile({ type: "chunk", id: lazyPath });
            },
          },
          output: { comments: false, format: "esm" },
        });
      } catch (error) {
        caught = error as Error;
      }

      expect(caught).toBeInstanceOf(Error);
      const message = caught?.message ?? "";
      expect(message).toMatch(
        /^Expected one bundled multi-chunk fixture, but Rolldown emitted \d+ chunks:/,
      );
      expect(message).toContain("(entry):");
      expect(message).toContain("(non-entry):");
      expect(message).toContain("src/entry.ts");
      expect(message).toContain("src/mid.ts");
      expect(message).toContain("src/lazy.ts");
      expect(message).toContain("src/leaf.ts");
      expect(message).toContain("src/entry.ts -> src/mid.ts --import()--> src/lazy.ts");
      expect(message).toContain(
        "src/entry.ts -> src/mid.ts --import()--> src/lazy.ts -> src/leaf.ts",
      );
      expect(message).toContain("Check the non-entry modules and import() edges listed above.");
      expect(message).not.toContain("\0");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("traces every direct importer chain in diamond and dual-edge graphs", async () => {
    let caught: Error | undefined;
    try {
      await buildSingleRolldownChunk("diamond fixture", {
        input: "\0entry.js",
        plugins: [
          {
            name: "diamond-graph",
            resolveId(id: string) {
              return id.startsWith("\0") ? id : undefined;
            },
            load(id: string) {
              if (id === "\0entry.js") {
                return 'import { s, load, reload } from "\0index.js";\nexport const out = [s, load, reload];\n';
              }
              if (id === "\0index.js") {
                return 'import { surface } from "\0surface.js";\nimport { load } from "\0io.js";\nexport const s = surface;\nexport const reload = () => import("\0surface.js");\nexport { load };\n';
              }
              if (id === "\0io.js") {
                return 'export const load = () => import("\0lazy.js").then((m) => m.lazy);\n';
              }
              if (id === "\0lazy.js") {
                return 'import { surface } from "\0surface.js";\nexport const lazy = surface + 1;\n';
              }
              if (id === "\0surface.js") {
                return "export const surface = 42;\n";
              }
              return undefined;
            },
            buildStart() {
              this.emitFile({ type: "chunk", id: "\0surface.js" });
            },
          },
        ],
        output: { comments: false, format: "esm" },
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = caught?.message ?? "";
    expect(message).toContain("\\0entry.js -> \\0index.js -> \\0surface.js");
    expect(message).toContain("\\0entry.js -> \\0index.js --import()--> \\0surface.js");
    expect(message).toContain(
      "\\0entry.js -> \\0index.js -> \\0io.js --import()--> \\0lazy.js -> \\0surface.js",
    );
  });

  it("tailors the hint when all emitted chunks are entry chunks", async () => {
    let caught: Error | undefined;
    try {
      await buildSingleRolldownChunk("all-entry fixture", {
        input: "\0entry.js",
        plugins: [
          {
            name: "emit-unrelated-entry",
            resolveId(id: string) {
              return id.startsWith("\0") ? id : undefined;
            },
            load(id: string) {
              if (id === "\0entry.js") return "export const a = 1;\n";
              if (id === "\0extra.js") return "export const b = 2;\n";
              return undefined;
            },
            buildStart() {
              this.emitFile({ type: "chunk", id: "\0extra.js" });
            },
          },
        ],
        output: { comments: false, format: "esm" },
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = caught?.message ?? "";
    expect(message).toMatch(
      /^Expected one bundled all-entry fixture, but Rolldown emitted 2 chunks:/,
    );
    expect(message).toContain("\\0entry.js");
    expect(message).toContain("\\0extra.js");
    expect(message).not.toContain("(non-entry):");
    expect(message).toContain("Check the extra entry chunks listed above.");
    expect(message).not.toContain("Check the non-entry modules");
  });

  it("bounds multi-chunk diagnostics on cyclic graphs and large chunk or module counts", async () => {
    const extraCount = 12;
    const extraIds = Array.from({ length: extraCount }, (_, index) => `\0extra-${index}.js`);
    const helperIds = Array.from({ length: 10 }, (_, index) => `\0helper-${index}.js`);

    let caught: Error | undefined;
    try {
      await buildSingleRolldownChunk("cyclic large fixture", {
        input: "\0entry.js",
        plugins: [
          null,
          false,
          [
            {
              name: "cyclic-virtual-graph",
              resolveId(id: string) {
                return id.startsWith("\0") ? id : undefined;
              },
              load(id: string) {
                if (id === "\0entry.js") {
                  const helperImports = helperIds
                    .map(
                      (helperId, index) => `import { h${index} } from ${JSON.stringify(helperId)};`,
                    )
                    .join("\n");
                  const helperList = helperIds.map((_, index) => `h${index}`).join(", ");
                  return `${helperImports}\nimport { a, loaders } from "\0cycle-a.js";\nexport const value = [a, loaders, ${helperList}];\n`;
                }
                const helperIndex = helperIds.indexOf(id);
                if (helperIndex !== -1) {
                  return `export function h${helperIndex}() { return ${helperIndex}; }\n`;
                }
                if (id === "\0cycle-a.js") {
                  return 'import { b, loaders } from "\0cycle-b.js";\nexport const a = b + 1;\nexport { loaders };\n';
                }
                if (id === "\0cycle-b.js") {
                  const extraImports = extraIds
                    .map(
                      (extraId, index) =>
                        `() => import(${JSON.stringify(extraId)}).then((m) => m.e${index})`,
                    )
                    .join(", ");
                  return `import { a } from "\0cycle-a.js";\nexport const b = a ? 1 : 0;\nexport const loaders = [${extraImports}];\n`;
                }
                const extraIndex = extraIds.indexOf(id);
                if (extraIndex !== -1) {
                  return `export const e${extraIndex} = ${extraIndex};\n`;
                }
                return undefined;
              },
              buildStart() {
                for (const extraId of extraIds) {
                  this.emitFile({ type: "chunk", id: extraId });
                }
              },
            },
          ],
        ],
        output: { comments: false, format: "esm" },
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = caught?.message ?? "";
    expect(message).toMatch(
      /^Expected one bundled cyclic large fixture, but Rolldown emitted \d+ chunks:/,
    );
    expect(message).toContain("\\0entry.js");
    expect(message).not.toContain("\0");
    expect(message).toContain("more chunks");
    expect(message).toContain("more non-entry modules");
    expect(message).toMatch(/\+\d+ more\b/);
    expect(message).toContain(
      "\\0entry.js -> \\0cycle-a.js -> \\0cycle-b.js --import()--> \\0extra-0.js",
    );
  });

  it("reports when Rolldown emits no chunks", async () => {
    await expect(
      buildSingleRolldownChunk("empty fixture", {
        input: "\0entry.js",
        plugins: [
          {
            name: "drop-emitted-chunks",
            resolveId(id: string) {
              return id === "\0entry.js" ? id : undefined;
            },
            load(id: string) {
              return id === "\0entry.js" ? "export const x = 1;" : undefined;
            },
            generateBundle(_options, bundle) {
              for (const key of Object.keys(bundle)) {
                delete bundle[key];
              }
            },
          },
        ],
        output: { comments: false, format: "esm" },
      }),
    ).rejects.toThrow("Expected one bundled empty fixture, but Rolldown emitted no chunks.");
  });
});
