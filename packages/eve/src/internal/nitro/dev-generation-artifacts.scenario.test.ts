import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgent } from "#compiler/compile-agent.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { loadCompiledModuleMapFromAuthoredSource } from "#internal/authored-module-map-loader.js";
import {
  discardDevelopmentGeneration,
  stageDevelopmentGeneration,
} from "#internal/nitro/development-generation.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "#internal/application/runtime-compiled-artifacts-source.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";

describe("development generation artifacts", () => {
  const scenarioApp = useScenarioApp();

  it("executes dynamic imports after the original bundled dependency is removed", async () => {
    const evaluationMarker = "__eveGenerationDynamicImportEvaluated__";
    const globals = globalThis as Record<string, unknown>;
    delete globals[evaluationMarker];
    const app = await scenarioApp({
      dependencies: {
        pg: "1.0.0",
      },
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.md": "Use the available tools.",
        "agent/tools/read_dynamic.mjs": [
          'import { readDynamicValue } from "pg";',
          "",
          "export default {",
          '  description: "Read a dynamically imported value.",',
          "  execute: readDynamicValue,",
          "};",
          "",
        ].join("\n"),
      },
      name: "generation-dynamic-import",
    });
    const dependencyRoot = join(app.appRoot, "node_modules", "pg");
    await mkdir(dependencyRoot, { recursive: true });
    await writeFile(
      join(dependencyRoot, "package.json"),
      `${JSON.stringify({ exports: "./index.mjs", name: "pg", type: "module" })}\n`,
    );
    await writeFile(
      join(dependencyRoot, "index.mjs"),
      [
        "export async function readDynamicValue() {",
        '  return (await import("./dynamic.mjs")).value;',
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(dependencyRoot, "dynamic.mjs"),
      [
        `globalThis[${JSON.stringify(evaluationMarker)}] = true;`,
        'export const value = "original";',
        "",
      ].join("\n"),
    );

    const compileResult = await compileAgent({ startPath: app.appRoot });
    const snapshot = await stageDevelopmentGeneration(compileResult);

    await rm(join(app.appRoot, "node_modules"), { force: true, recursive: true });
    const moduleMap = await loadCompiledModuleMapFromAuthoredSource({
      compiledArtifactsSource: createAuthoredSourceRuntimeCompiledArtifactsSource(
        snapshot.runtimeAppRoot,
      ),
    });
    const toolSourceId = compileResult.manifest.tools[0]?.sourceId;
    expect(toolSourceId).toBeDefined();
    const tool = moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]?.modules[toolSourceId!] as {
      default: { execute(): Promise<string> };
    };

    expect(globals[evaluationMarker]).toBeUndefined();
    await expect(tool.default.execute()).resolves.toBe("original");
    expect(globals[evaluationMarker]).toBe(true);
    delete globals[evaluationMarker];
  });

  it("bundles ordinary dependencies while configured externals keep runtime resolution", async () => {
    const app = await scenarioApp({
      dependencies: {
        "fixture-bundled": "1.0.0",
        "fixture-external": "1.0.0",
      },
      files: {
        "agent/agent.mjs": [
          "export default {",
          '  model: "openai/gpt-5.4",',
          '  build: { externalDependencies: ["fixture-external"] },',
          "};",
          "",
        ].join("\n"),
        "agent/instructions.md": "Use the available tools.",
        "agent/tools/read_value.mjs": [
          'import { bundledValue } from "fixture-bundled";',
          'import { externalValue } from "fixture-external/feature";',
          "",
          "export default {",
          '  description: "Read dependency values.",',
          "  execute() {",
          "    return `${bundledValue}:${externalValue}`;",
          "  },",
          "};",
          "",
        ].join("\n"),
      },
      name: "immutable-generation-closure",
    });
    const externalFixtureRoot = await writeDependencyFixture(app.appRoot);

    const compileResult = await compileAgent({ startPath: app.appRoot });
    const snapshot = await stageDevelopmentGeneration(compileResult);
    const externalPackagePath = join(snapshot.runtimeAppRoot, "node_modules", "fixture-external");
    const resolvedExternalPath = await realpath(externalPackagePath);
    const canonicalSnapshotRoot = await realpath(snapshot.snapshotRoot);

    expect(relative(canonicalSnapshotRoot, resolvedExternalPath)).toMatch(/^\.\.(?:[\\/]|$)/u);
    expect(existsSync(join(resolvedExternalPath, "binding.node"))).toBe(true);

    await rm(join(app.appRoot, "node_modules", "fixture-bundled"), {
      force: true,
      recursive: true,
    });
    await rm(join(app.appRoot, "node_modules", "@workflow"), { force: true, recursive: true });
    await writeFile(
      join(app.appRoot, "agent", "tools", "read_value.mjs"),
      'throw new Error("mutated source loaded");\n',
    );

    const moduleMap = await loadCompiledModuleMapFromAuthoredSource({
      compiledArtifactsSource: createAuthoredSourceRuntimeCompiledArtifactsSource(
        snapshot.runtimeAppRoot,
      ),
    });
    const toolSourceId = compileResult.manifest.tools[0]?.sourceId;
    expect(toolSourceId).toBeDefined();
    const tool = moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]?.modules[toolSourceId!] as {
      default: { execute(): string };
    };

    expect(tool.default.execute()).toBe(
      "bundled-original:serde-original:external-original:payload-original",
    );
    await rm(externalFixtureRoot, { force: true, recursive: true });
  });

  it("uses a path-independent fingerprint that includes instrumentation", async () => {
    const app = await scenarioApp({
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instrumentation.mjs": 'export default { marker: "one" };\n',
        "agent/instructions.md": "Use the configured model.",
        "agent/skills/guide.md": [
          "---",
          "description: Follow the guide.",
          "---",
          "",
          "Use the original guidance.",
          "",
        ].join("\n"),
      },
      name: "generation-fingerprint",
    });
    const firstCompile = await compileAgent({ startPath: app.appRoot });
    const first = await stageDevelopmentGeneration(firstCompile);
    const identical = await stageDevelopmentGeneration(firstCompile);
    const firstIndex = JSON.parse(
      await readFile(
        join(first.runtimeAppRoot, ".eve", "compile", "authored-modules.json"),
        "utf8",
      ),
    ) as { readonly instrumentation?: string };
    const materializedInstrumentation = await readFile(
      join(first.runtimeAppRoot, ".eve", "compile", firstIndex.instrumentation!),
      "utf8",
    );

    expect(first.fingerprint).toBe(identical.fingerprint);
    expect(materializedInstrumentation).not.toContain("/.eve/dev-runtime/snapshots/");

    await writeFile(
      join(app.appRoot, "agent", "instructions.md"),
      "Use the configured model and explain the result.",
    );
    const changedInstructions = await stageDevelopmentGeneration(
      await compileAgent({ startPath: app.appRoot }),
    );
    expect(changedInstructions.fingerprint).not.toBe(first.fingerprint);

    await writeFile(join(app.appRoot, "agent", "instructions.md"), "Use the configured model.");
    const restoredInstructions = await stageDevelopmentGeneration(
      await compileAgent({ startPath: app.appRoot }),
    );
    expect(restoredInstructions.fingerprint).toBe(first.fingerprint);

    await writeFile(
      join(app.appRoot, "agent", "instrumentation.mjs"),
      'export default { marker: "two" };\n',
    );
    const changedCompile = await compileAgent({ startPath: app.appRoot });
    const changed = await stageDevelopmentGeneration(changedCompile);

    expect(changed.fingerprint).not.toBe(first.fingerprint);
    await expect(
      readFile(join(changed.runtimeAppRoot, ".eve", "compile", "authored-modules.json"), "utf8"),
    ).resolves.toContain('"instrumentation"');

    await writeFile(
      join(app.appRoot, "agent", "skills", "guide.md"),
      ["---", "description: Follow the guide.", "---", "", "Use the changed guidance.", ""].join(
        "\n",
      ),
    );
    const changedResources = await stageDevelopmentGeneration(
      await compileAgent({ startPath: app.appRoot }),
    );
    expect(changedResources.fingerprint).not.toBe(changed.fingerprint);
  });

  it("rejects only authored workflow directives", async () => {
    const app = await scenarioApp({
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.md": "Use the available tools.",
        "agent/tools/directive_text.mjs": [
          '// "use workflow" is documentation.',
          'const message = "use step";',
          '"use workflow";',
          'export default { description: "Return text.", execute: () => message };',
          "",
        ].join("\n"),
      },
      name: "authored-directive-guard",
    });
    const validCompile = await compileAgent({ startPath: app.appRoot });

    await expect(stageDevelopmentGeneration(validCompile)).resolves.toBeDefined();
    const snapshotsRoot = join(app.appRoot, ".eve", "dev-runtime", "snapshots");
    const stagedGenerations = await readdir(snapshotsRoot);

    await writeFile(
      join(app.appRoot, "agent", "tools", "directive_text.mjs"),
      [
        '"use step";',
        'export default { description: "Return text.", execute: () => "invalid" };',
        "",
      ].join("\n"),
    );
    const invalidCompile = await compileAgent({ startPath: app.appRoot });

    await expect(stageDevelopmentGeneration(invalidCompile)).rejects.toThrow(
      /actual "use step" directive/u,
    );
    await expect(readdir(snapshotsRoot)).resolves.toEqual(stagedGenerations);
  });

  it("discards a staged generation that was never activated", async () => {
    const app = await scenarioApp({
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.md": "Use the configured model.",
      },
      name: "discard-generation",
    });
    const compileResult = await compileAgent({ startPath: app.appRoot });
    const snapshot = await stageDevelopmentGeneration(compileResult);

    await discardDevelopmentGeneration(snapshot);

    expect(existsSync(snapshot.snapshotRoot)).toBe(false);
  });
});

async function writeDependencyFixture(appRoot: string): Promise<string> {
  const nodeModulesRoot = join(appRoot, "node_modules");
  const bundledRoot = join(nodeModulesRoot, "fixture-bundled");
  const externalFixtureRoot = join(dirname(appRoot), `${basename(appRoot)}-linked-dependencies`);
  const externalRoot = join(externalFixtureRoot, "fixture-external");
  const transitiveRoot = join(externalFixtureRoot, "fixture-transitive");

  await mkdir(bundledRoot, { recursive: true });
  await writeFile(
    join(bundledRoot, "package.json"),
    `${JSON.stringify({ exports: "./index.mjs", name: "fixture-bundled", type: "module" })}\n`,
  );
  // eve vendors `@workflow/*`, so a transitive workflow import reachable only
  // through an inlined dependency must be inlined with it — a bare specifier
  // would be unresolvable once the generation outlives `node_modules`.
  await writeFile(
    join(bundledRoot, "index.mjs"),
    [
      '"use workflow";',
      'import { serdeMarker } from "@workflow/serde";',
      "export const bundledValue = `bundled-original:${serdeMarker}`;",
      "",
    ].join("\n"),
  );

  const vendoredWorkflowRoot = join(nodeModulesRoot, "@workflow", "serde");
  await mkdir(vendoredWorkflowRoot, { recursive: true });
  await writeFile(
    join(vendoredWorkflowRoot, "package.json"),
    `${JSON.stringify({ exports: "./index.mjs", name: "@workflow/serde", type: "module" })}\n`,
  );
  await writeFile(
    join(vendoredWorkflowRoot, "index.mjs"),
    'export const serdeMarker = "serde-original";\n',
  );

  await mkdir(externalRoot, { recursive: true });
  await writeFile(
    join(externalRoot, "package.json"),
    `${JSON.stringify({
      dependencies: { "fixture-transitive": "1.0.0" },
      exports: {
        "./feature": {
          import: "./feature.mjs",
          require: "./wrong.cjs",
        },
      },
      name: "fixture-external",
      type: "module",
    })}\n`,
  );
  await writeFile(
    join(externalRoot, "feature.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'import { transitiveValue } from "fixture-transitive";',
      'export const externalValue = `${transitiveValue}:${readFileSync(new URL("./payload.txt", import.meta.url), "utf8").trim()}`;',
      "",
    ].join("\n"),
  );
  await writeFile(join(externalRoot, "wrong.cjs"), 'throw new Error("require export used");\n');
  await writeFile(join(externalRoot, "binding.node"), "native-addon-placeholder\n");
  await writeFile(join(externalRoot, "payload.txt"), "payload-original\n");
  await mkdir(join(externalRoot, "node_modules"), { recursive: true });

  await mkdir(transitiveRoot, { recursive: true });
  await writeFile(
    join(transitiveRoot, "package.json"),
    `${JSON.stringify({
      exports: "./index.mjs",
      name: "fixture-transitive",
      type: "module",
    })}\n`,
  );
  await writeFile(
    join(transitiveRoot, "index.mjs"),
    'export const transitiveValue = "external-original";\n',
  );

  await symlink(
    transitiveRoot,
    join(externalRoot, "node_modules", "fixture-transitive"),
    "junction",
  );
  await symlink(externalRoot, join(nodeModulesRoot, "fixture-external"), "junction");
  return externalFixtureRoot;
}
