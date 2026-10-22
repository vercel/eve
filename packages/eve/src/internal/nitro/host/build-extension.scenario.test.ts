import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
  EXTENSION_DISTRIBUTION_CONTRACT_MAJOR,
  parseExtensionCompatibilityManifest,
} from "#compiler/extension-compatibility.js";
import {
  buildExtensionPackage,
  tryReadExtensionBuildConfig,
} from "#internal/nitro/host/build-extension.js";

// `buildExtensionPackage` transforms a multi-entry graph with rolldown and emits
// declarations with TypeScript, so these publishing-contract checks are scenario tier.
async function createExtensionPackage(pkg?: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-ext-scenario-"));
  const evePackageRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@acme/crm",
      type: "module",
      eve: { extension: { source: "extension", dist: "dist/extension" } },
      files: ["dist"],
      peerDependencies: { eve: "*" },
      ...pkg,
    }),
    "utf8",
  );
  await mkdir(join(root, "node_modules"), { recursive: true });
  await symlink(evePackageRoot, join(root, "node_modules", "eve"), "dir");
  await mkdir(join(root, "extension", "tools"), { recursive: true });
  await writeFile(
    join(root, "extension", "extension.ts"),
    `import { defineExtension } from "eve/extension";
export default defineExtension();
`,
    "utf8",
  );
  await writeFile(
    join(root, "extension", "tools", "crm_search.ts"),
    `export default { description: "Search the CRM.", async execute() { return {}; } };
`,
    "utf8",
  );
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "esnext",
        moduleResolution: "bundler",
        skipLibCheck: true,
        types: [],
      },
      include: ["extension/**/*.ts"],
    }),
    "utf8",
  );
  return root;
}

describe("extension build output", () => {
  it.each([true, false])(
    "omits test runtime entries with authored tsconfig=%s",
    async (hasTsConfig) => {
      const root = await createExtensionPackage();
      if (!hasTsConfig) await rm(join(root, "tsconfig.json"));
      const files = {
        "tools/crm_search.test.ts": hasTsConfig
          ? 'throw new Error("test executed"); export {};'
          : 'describe("crm", () => { it("works", () => { expect(1).toBe(1); }); });',
        "lib/client.spec.ts": 'throw new Error("spec executed"); export {};',
        "lib/state.test.ts":
          'import { defineState } from "eve/context"; export const state = defineState("test", () => 0);',
        "tools/__tests__/setup.ts": 'throw new Error("test setup executed"); export {};',
        "tools/__tests__/_manifest.json": "{}",
        "skills/checks/SKILL.md":
          "---\nname: checks\ndescription: Run checks.\n---\nRun the checks.",
        "skills/checks/scripts/check.test.ts":
          'import { defineState } from "eve/context"; defineState("resource-test", () => 0);',
      };
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(root, "extension", path)), { recursive: true });
        await writeFile(join(root, "extension", path), content);
      }
      const config = await tryReadExtensionBuildConfig(root);
      const outDir = await buildExtensionPackage(root, config!);
      const emitted = await readdir(join(outDir, "extension"), { recursive: true });
      expect(emitted.filter((path) => path.endsWith(".mjs")).sort()).toEqual([
        "extension.mjs",
        join("tools", "crm_search.mjs"),
      ]);
      expect(emitted).toContain(join("skills", "checks", "scripts", "check.test.ts"));
      expect(emitted.includes(join("tools", "crm_search.test.d.ts"))).toBe(hasTsConfig);
      expect(emitted.includes(join("tools", "__tests__", "setup.d.ts"))).toBe(hasTsConfig);
      const manifestPath = join(outDir, "extension", "_manifest.json");
      expect(
        parseExtensionCompatibilityManifest(await readFile(manifestPath, "utf8"), manifestPath),
      ).toMatchObject({
        formatVersion: EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
        contractMajor: EXTENSION_DISTRIBUTION_CONTRACT_MAJOR,
      });
    },
  );

  it("emits an agent-shaped runnable distribution and thin package entrypoints", async () => {
    const root = await createExtensionPackage();
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);

    const index = await readFile(join(outDir, "index.mjs"), "utf8");
    expect(index).toMatch(/from\s+["']\.\/extension\/extension\.mjs["']/);

    // `eve/*` stays external so the mount resolves to the consumer's eve.
    const extensionModule = await readFile(join(outDir, "extension", "extension.mjs"), "utf8");
    expect(extensionModule).toMatch(/from\s+["']eve\/extension["']/);

    const toolsIndex = await readFile(join(outDir, "tools", "index.mjs"), "utf8");
    expect(toolsIndex).toMatch(/from\s+["']\.\.\/extension\/tools\/crm_search\.mjs["']/);
    expect(await readFile(join(outDir, "extension", "tools", "crm_search.mjs"), "utf8")).toContain(
      "Search the CRM",
    );
  });

  it("retains explicitly imported test modules without a tsconfig", async () => {
    const root = await createExtensionPackage();
    await rm(join(root, "tsconfig.json"));
    await mkdir(join(root, "extension", "lib", "__tests__"), { recursive: true });
    await writeFile(
      join(root, "extension", "lib", "__tests__", "value.ts"),
      'import { defineState } from "eve/context"; export const state = defineState("value", () => 0); export const value = "imported value";',
    );
    await writeFile(
      join(root, "extension", "tools", "crm_search.ts"),
      [
        'import { state, value } from "../lib/__tests__/value";',
        'export default { description: "Search the CRM.", async execute() { return { value, hasState: state !== undefined }; } };',
      ].join("\n"),
    );
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);
    const tool = await import(
      pathToFileURL(join(outDir, "extension", "tools", "crm_search.mjs")).href
    );
    await expect(tool.default.execute()).resolves.toEqual({
      value: "imported value",
      hasState: true,
    });
    expect(
      await readFile(join(outDir, "extension", "lib", "__tests__", "value.d.ts"), "utf8"),
    ).toContain("imported value");
    const manifestPath = join(outDir, "extension", "_manifest.json");
    expect(
      parseExtensionCompatibilityManifest(await readFile(manifestPath, "utf8"), manifestPath),
    ).toMatchObject({
      formatVersion: EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
      contractMajor: EXTENSION_DISTRIBUTION_CONTRACT_MAJOR,
    });
  });

  it("stamps extension-owned external dependencies into compatibility metadata", async () => {
    const root = await createExtensionPackage({
      dependencies: { "layout-sensitive-runtime": "1.0.0" },
      eve: {
        extension: {
          source: "extension",
          dist: "dist/extension",
          externalDependencies: ["layout-sensitive-runtime"],
        },
      },
    });
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);
    const manifestPath = join(outDir, "extension", "_manifest.json");

    expect(
      parseExtensionCompatibilityManifest(await readFile(manifestPath, "utf8"), manifestPath),
    ).toMatchObject({
      formatVersion: EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
      build: { externalDependencies: ["layout-sensitive-runtime"] },
    });
  });

  it("rejects external dependencies without a runtime package declaration", async () => {
    const root = await createExtensionPackage({
      eve: {
        extension: {
          source: "extension",
          dist: "dist/extension",
          externalDependencies: ["layout-sensitive-runtime"],
        },
      },
    });

    await expect(tryReadExtensionBuildConfig(root)).rejects.toThrow(
      /Missing runtime declarations: layout-sensitive-runtime/,
    );
  });

  it("preserves shared module identity across transformed contribution entries", async () => {
    const root = await createExtensionPackage();
    await mkdir(join(root, "extension", "lib"), { recursive: true });
    await writeFile(
      join(root, "extension", "lib", "counter.ts"),
      `let count = 0;
export const next = () => ++count;
`,
      "utf8",
    );
    for (const name of ["first", "second"]) {
      await writeFile(
        join(root, "extension", "tools", `${name}.ts`),
        [
          'import { next } from "../lib/counter";',
          `export default { description: "${name}", async execute() { return next(); } };`,
          "",
        ].join("\n"),
        "utf8",
      );
    }
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);
    const firstPath = join(outDir, "extension", "tools", "first.mjs");
    const secondPath = join(outDir, "extension", "tools", "second.mjs");

    expect(await readFile(firstPath, "utf8")).toMatch(/\.\.\/lib\/counter\.mjs/);
    expect(await readFile(secondPath, "utf8")).toMatch(/\.\.\/lib\/counter\.mjs/);
    const first = (await import(pathToFileURL(firstPath).href)) as {
      default: { execute(): Promise<number> };
    };
    const second = (await import(pathToFileURL(secondPath).href)) as {
      default: { execute(): Promise<number> };
    };
    await expect(first.default.execute()).resolves.toBe(1);
    await expect(second.default.execute()).resolves.toBe(2);
  });

  it("emits declaration barrels and declarations entirely inside dist", async () => {
    const root = await createExtensionPackage();
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);

    const indexDts = await readFile(join(outDir, "index.d.ts"), "utf8");
    expect(indexDts).toContain('export { default } from "./extension/extension.js"');
    expect(indexDts).toContain('export { default as crm } from "./extension/extension.js"');

    const toolsDts = await readFile(join(outDir, "tools", "index.d.ts"), "utf8");
    expect(toolsDts).toContain(
      'export { default as crm_search } from "../extension/tools/crm_search.js"',
    );
    expect(await readFile(join(outDir, "extension", "extension.d.ts"), "utf8")).toContain(
      "export default",
    );
  });

  it("emits portable declarations for default-exported hooks", async () => {
    const root = await createExtensionPackage();
    await mkdir(join(root, "extension", "hooks"), { recursive: true });
    await writeFile(
      join(root, "extension", "hooks", "audit.ts"),
      [
        'import { defineHook } from "eve/hooks";',
        "",
        "export default defineHook({",
        "  events: {",
        '    "call.settled"(event) {',
        "      console.info(event.data.output);",
        "    },",
        "  },",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);

    const declaration = await readFile(join(outDir, "extension", "hooks", "audit.d.ts"), "utf8");
    expect(declaration).toMatch(
      /import\(["']eve\/hooks["']\)\.HookDefinition<["']call\.settled["']>/,
    );
    expect(declaration).not.toContain("protocol/message");
  });

  it("copies data files and stamps only the extension capabilities in use", async () => {
    const root = await createExtensionPackage();
    await writeFile(
      join(root, "extension", "extension.ts"),
      [
        'import { defineExtension } from "eve/extension";',
        'const config = { "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) } } as const;',
        "export default defineExtension({ config });",
        "",
      ].join("\n"),
      "utf8",
    );
    await mkdir(join(root, "extension", "lib"), { recursive: true });
    await writeFile(
      join(root, "extension", "lib", "budget.ts"),
      [
        'import { defineState as state } from "eve/context";',
        'export const budget = state("budget", () => 1);',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(root, "extension", "tools", "crm_search.ts"),
      [
        'import { defineDynamic, defineTool } from "eve/tools";',
        "export default defineDynamic(() => defineTool({",
        '    description: "Search the CRM.",',
        '    inputSchema: { type: "object", properties: {}, additionalProperties: false },',
        "    async execute() { return {}; },",
        "  }),",
        ");",
        "",
      ].join("\n"),
      "utf8",
    );
    await mkdir(join(root, "extension", "skills", "triage", "references"), {
      recursive: true,
    });
    await writeFile(
      join(root, "extension", "skills", "triage", "SKILL.md"),
      "---\nname: triage\ndescription: Triage a request.\n---\n\n# Triage\n",
      "utf8",
    );
    await writeFile(
      join(root, "extension", "skills", "triage", "references", "prompt.txt"),
      "runtime data\n",
      "utf8",
    );
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);

    const manifestPath = join(outDir, "extension", "_manifest.json");
    const manifest = parseExtensionCompatibilityManifest(
      await readFile(manifestPath, "utf8"),
      manifestPath,
    );
    expect(manifest.kind).toBe("eve-extension");
    expect(manifest.builtWithEve).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest).toMatchObject({
      formatVersion: EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
      contractMajor: EXTENSION_DISTRIBUTION_CONTRACT_MAJOR,
    });
    const dynamicToolDeclaration = await readFile(
      join(outDir, "extension", "tools", "crm_search.d.ts"),
      "utf8",
    );
    expect(dynamicToolDeclaration).toMatch(/import\("eve(?:\/tools)?"\)\.DynamicSentinel/u);
    expect(dynamicToolDeclaration).not.toContain("node_modules");
    expect(
      await readFile(
        join(outDir, "extension", "skills", "triage", "references", "prompt.txt"),
        "utf8",
      ),
    ).toBe("runtime data\n");
  });

  it("preserves JavaScript files inside packaged skill resource trees", async () => {
    const root = await createExtensionPackage();
    await mkdir(join(root, "extension", "skills", "triage", "scripts"), {
      recursive: true,
    });
    await writeFile(
      join(root, "extension", "skills", "triage", "SKILL.md"),
      "---\ndescription: Triage a request.\n---\n\nRun scripts/check.js.\n",
      "utf8",
    );
    const script = `export const token = "skill-script-resource";
`;
    await writeFile(
      join(root, "extension", "skills", "triage", "scripts", "check.js"),
      script,
      "utf8",
    );
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);

    await expect(
      readFile(join(outDir, "extension", "skills", "triage", "scripts", "check.js"), "utf8"),
    ).resolves.toBe(script);
    await expect(
      readFile(join(outDir, "extension", "skills", "triage", "scripts", "check.mjs"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves test files inside subagent sandbox workspaces", async () => {
    const root = await createExtensionPackage();
    const subagentRoot = join(root, "extension", "subagents", "researcher");
    const workspaceFiles = {
      "check.test.js": 'describe("workspace", () => {});',
      "__tests__/fixture.json": '{"value":"workspace fixture"}',
    };
    for (const [path, content] of Object.entries(workspaceFiles)) {
      const filePath = join(subagentRoot, "sandbox", "workspace", path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    }
    await writeFile(join(subagentRoot, "agent.ts"), 'export default { description: "Research." };');
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);
    const workspace = join(outDir, "extension", "subagents", "researcher", "sandbox", "workspace");
    for (const [path, content] of Object.entries(workspaceFiles)) {
      await expect(readFile(join(workspace, path), "utf8")).resolves.toBe(content);
    }
  });

  it("sanitizes kebab-case tool names into valid export bindings", async () => {
    const root = await createExtensionPackage();
    await writeFile(
      join(root, "extension", "tools", "get-weather.ts"),
      `export default { description: "Get the weather.", async execute() { return {}; } };
`,
      "utf8",
    );
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);

    const toolsDts = await readFile(join(outDir, "tools", "index.d.ts"), "utf8");
    expect(toolsDts).toContain("as get_weather ");
    expect(toolsDts).not.toContain("as get-weather ");
  });

  it("fills the exports map with runnable + types conditions", async () => {
    const root = await createExtensionPackage();
    const config = await tryReadExtensionBuildConfig(root);
    await buildExtensionPackage(root, config!);

    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    expect(pkg.exports).toEqual({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.mjs" },
      "./tools": { types: "./dist/tools/index.d.ts", default: "./dist/tools/index.mjs" },
    });
  });

  it("preserves the last successful dist when a rebuild fails", async () => {
    const root = await createExtensionPackage();
    const config = await tryReadExtensionBuildConfig(root);
    const outDir = await buildExtensionPackage(root, config!);
    await writeFile(join(outDir, "last-success.txt"), "keep\n", "utf8");
    await writeFile(
      join(root, "extension", "tools", "crm_search.ts"),
      `const invalid: "expected" = "actual";
export default { description: invalid, async execute() { return {}; } };
`,
      "utf8",
    );

    await expect(buildExtensionPackage(root, config!)).rejects.toThrow(/TS2322/);
    await expect(readFile(join(outDir, "last-success.txt"), "utf8")).resolves.toBe("keep\n");
  });

  it("explains a tsconfig whose include misses the extension source", async () => {
    const root = await createExtensionPackage();
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(
      join(root, "scripts", "release.ts"),
      `export const release = true;
`,
      "utf8",
    );
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "esnext",
          moduleResolution: "bundler",
          skipLibCheck: true,
          types: [],
        },
        include: ["scripts/**/*.ts"],
      }),
      "utf8",
    );
    const config = await tryReadExtensionBuildConfig(root);

    await expect(buildExtensionPackage(root, config!)).rejects.toThrow(
      /TypeScript emitted no declarations for "extension"/,
    );
  });

  it("rejects a published module excluded by the package tsconfig", async () => {
    const root = await createExtensionPackage();
    await writeFile(
      join(root, "extension", "tools", "excluded.mts"),
      `export default { description: "Excluded declaration.", async execute() { return {}; } };
`,
      "utf8",
    );
    const config = await tryReadExtensionBuildConfig(root);

    await expect(buildExtensionPackage(root, config!)).rejects.toThrow(
      'TypeScript emitted no declaration for extension module "tools/excluded.mts"',
    );
  });

  it("upgrades a stale bare-string export entry to the runnable + types shape", async () => {
    const root = await createExtensionPackage({ exports: { ".": "./dist/index.mjs" } });
    const config = await tryReadExtensionBuildConfig(root);
    await buildExtensionPackage(root, config!);

    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    expect(pkg.exports?.["."]).toEqual({ types: "./dist/index.d.ts", default: "./dist/index.mjs" });
  });
});
