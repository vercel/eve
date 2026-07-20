import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { parseExtensionCompatibilityManifest } from "#compiler/extension-compatibility.js";
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
    'import { defineExtension } from "eve/extension";\nexport default defineExtension();\n',
    "utf8",
  );
  await writeFile(
    join(root, "extension", "tools", "crm_search.ts"),
    'export default { description: "Search the CRM.", async execute() { return {}; } };\n',
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

  it("preserves shared module identity across transformed contribution entries", async () => {
    const root = await createExtensionPackage();
    await mkdir(join(root, "extension", "lib"), { recursive: true });
    await writeFile(
      join(root, "extension", "lib", "counter.ts"),
      "let count = 0;\nexport const next = () => ++count;\n",
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
        '    "action.result"(event) {',
        "      console.info(event.data.result);",
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
      /import\(["']eve\/hooks["']\)\.HookDefinition<["']action\.result["']>/,
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
        "export default defineDynamic({",
        "  events: {",
        '    "session.started": async () => defineTool({',
        '      description: "Search the CRM.",',
        '      inputSchema: { type: "object", properties: {}, additionalProperties: false },',
        "      async execute() { return {}; },",
        "    }),",
        "  },",
        "});",
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
    expect(manifest.requires).toEqual({
      extension: 1,
      tool: 1,
      dynamicTool: 1,
      skill: 1,
      config: 1,
      state: 1,
    });
    const dynamicToolDeclaration = await readFile(
      join(outDir, "extension", "tools", "crm_search.d.ts"),
      "utf8",
    );
    expect(dynamicToolDeclaration).toContain('import("eve/tools").DynamicSentinel');
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
    const script = 'export const token = "skill-script-resource";\n';
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

  it("sanitizes kebab-case tool names into valid export bindings", async () => {
    const root = await createExtensionPackage();
    await writeFile(
      join(root, "extension", "tools", "get-weather.ts"),
      'export default { description: "Get the weather.", async execute() { return {}; } };\n',
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
      'const invalid: "expected" = "actual";\nexport default { description: invalid, async execute() { return {}; } };\n',
      "utf8",
    );

    await expect(buildExtensionPackage(root, config!)).rejects.toThrow(/TS2322/);
    await expect(readFile(join(outDir, "last-success.txt"), "utf8")).resolves.toBe("keep\n");
  });

  it("explains a tsconfig whose include misses the extension source", async () => {
    const root = await createExtensionPackage();
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "scripts", "release.ts"), "export const release = true;\n", "utf8");
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
      'export default { description: "Excluded declaration.", async execute() { return {}; } };\n',
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
