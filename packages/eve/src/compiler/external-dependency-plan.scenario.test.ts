import { realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createCompiledExternalDependencyPlan,
  createCompiledExternalDependencyCaptureFromPackagePath,
  createCompiledExternalDependencyPlanSession,
  createCompiledExternalDependencySemanticHash,
  resolveCompiledExternalDependencyImport,
  verifyCompiledExternalDependencyPlanFiles,
} from "#compiler/external-dependency-plan.js";
import { createCompiledModuleMapIdentity } from "#compiler/module-map.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { discoverAgent } from "#discover/discover-agent.js";
import {
  createStubCompiledAgentManifest,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
} from "#internal/testing/compiled-manifest.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";

describe("compiled external dependency plan", () => {
  const scenarioApp = useScenarioApp();

  it("does not capture Node builtins declared as package dependencies", async () => {
    const app = await scenarioApp({
      files: {
        "node_modules/fixture-runtime/index.js": 'export { EventEmitter } from "events";\n',
        "node_modules/fixture-runtime/package.json": JSON.stringify({
          dependencies: { events: "3.3.0" },
          exports: "./index.js",
          name: "fixture-runtime",
          type: "module",
        }),
      },
      name: "external-dependency-node-builtin",
    });
    const plan = await createCompiledExternalDependencyPlan([
      {
        packageName: "fixture-runtime",
        scope: { kind: "application", nodeId: "__root__", sourceRoot: app.appRoot },
      },
    ]);

    expect(plan.entries[0]?.packages.map((pkg) => pkg.packageName)).toEqual(["fixture-runtime"]);
  });

  it("rotates semantic and module-map identity when a transitive package changes", async () => {
    const app = await scenarioApp({
      files: {
        "agent/tools/use-runtime.ts":
          'import { value } from "fixture-runtime";\nexport default value;\n',
        "node_modules/fixture-helper/index.js": 'export const value = "first";\n',
        "node_modules/fixture-helper/package.json": JSON.stringify({
          exports: "./index.js",
          name: "fixture-helper",
          type: "module",
        }),
        "node_modules/fixture-runtime/index.js": 'export { value } from "fixture-helper";\n',
        "node_modules/fixture-runtime/package.json": JSON.stringify({
          dependencies: { "fixture-helper": "1.0.0" },
          exports: "./index.js",
          name: "fixture-runtime",
          type: "module",
        }),
      },
      name: "external-dependency-identity",
    });
    const createPlan = async () =>
      await createCompiledExternalDependencyPlan([
        {
          packageName: "fixture-runtime",
          scope: { kind: "application", nodeId: "__root__", sourceRoot: app.appRoot },
        },
      ]);
    const toolPath = join(app.appRoot, "agent", "tools", "use-runtime.ts");
    const createManifest = (externalDependencyPlan: Awaited<ReturnType<typeof createPlan>>) =>
      createStubCompiledAgentManifest({
        agentRoot: join(app.appRoot, "agent"),
        appRoot: app.appRoot,
        bindings: [
          TEST_COMPILED_AGENT_CONFIG_BINDING,
          {
            binding: {
              backing: {
                externalDependencies: ["fixture-runtime"],
                kind: "filesystem",
                sourcePath: toolPath,
              },
              owner: { kind: "application" },
            },
            logicalPath: "tools/use-runtime.ts",
            sourceId: "tools/use-runtime.ts",
          },
        ],
        config: {
          build: { externalDependencies: ["fixture-runtime"] },
          model: { id: "openai/gpt-5.4-mini", routing: { kind: "gateway", target: "openai" } },
          name: "external-dependency-identity",
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        },
        externalDependencyPlan,
        tools: [
          {
            description: "Uses runtime.",
            inputSchema: null,
            logicalPath: "tools/use-runtime.ts",
            name: "use-runtime",
            sourceId: "tools/use-runtime.ts",
            sourceKind: "module",
          },
        ],
      });

    const firstPlan = await createPlan();
    const firstIdentity = await createCompiledModuleMapIdentity(createManifest(firstPlan));
    await writeFile(
      join(app.appRoot, "node_modules", "fixture-helper", "index.js"),
      'export const value = "second";\n',
    );
    const secondPlan = await createPlan();

    expect(secondPlan.entries[0]?.semanticSha256).not.toBe(firstPlan.entries[0]?.semanticSha256);
    await expect(createCompiledModuleMapIdentity(createManifest(secondPlan))).resolves.not.toBe(
      firstIdentity,
    );
    await expect(verifyCompiledExternalDependencyPlanFiles(firstPlan)).rejects.toThrow(
      "changed after compilation",
    );
  });

  it("finalizes the exact session-selected closure with its declared scope", async () => {
    const app = await scenarioApp({
      files: {
        "node_modules/fixture-runtime/index.js": 'export const value = "selected";\n',
        "node_modules/fixture-runtime/package.json": JSON.stringify({
          exports: "./index.js",
          name: "fixture-runtime",
          type: "module",
        }),
      },
      name: "external-dependency-session-finalization",
    });
    const request = {
      packageName: "fixture-runtime",
      scope: { kind: "application" as const, nodeId: "__root__", sourceRoot: app.appRoot },
    };
    const session = createCompiledExternalDependencyPlanSession();
    await session.register([request]);
    const selected = session.planFor([request.packageName]).entries[0]!;
    await expect(session.finalize([])).rejects.toThrow("is not declared by the compiled graph");
    await expect(createCompiledExternalDependencyPlanSession().finalize([request])).rejects.toThrow(
      "was not selected before definition loading",
    );
    const finalized = await session.finalize([request]);

    expect(finalized.entries[0]).toMatchObject({
      packages: selected.packages,
      scopes: [request.scope],
      semanticSha256: selected.semanticSha256,
    });
  });

  it("rejects conflicting owner closures before the next definition can execute", async () => {
    const app = await scenarioApp({
      files: {
        "extension/node_modules/shared-runtime/index.js": 'export const owner = "extension";\n',
        "extension/node_modules/shared-runtime/package.json": JSON.stringify({
          exports: "./index.js",
          name: "shared-runtime",
          type: "module",
        }),
        "extension/package.json": JSON.stringify({ name: "fixture-extension" }),
        "node_modules/shared-runtime/index.js": 'export const owner = "application";\n',
        "node_modules/shared-runtime/package.json": JSON.stringify({
          exports: "./index.js",
          name: "shared-runtime",
          type: "module",
        }),
      },
      name: "external-dependency-conflict",
    });

    const session = createCompiledExternalDependencyPlanSession();
    await session.register([
      {
        packageName: "shared-runtime",
        scope: { kind: "application", nodeId: "__root__", sourceRoot: app.appRoot },
      },
    ]);
    let definitionsExecuted = 0;
    await expect(
      (async () => {
        await session.register([
          {
            packageName: "shared-runtime",
            scope: {
              kind: "extension",
              namespace: "fixture",
              nodeId: "__root__",
              packageName: "fixture-extension",
              sourceRoot: join(app.appRoot, "extension"),
            },
          },
        ]);
        definitionsExecuted += 1;
      })(),
    ).rejects.toThrow("different executable closures");
    expect(definitionsExecuted).toBe(0);
  });

  it("rejects a config-bootstrap mutation before remaining definitions execute", async () => {
    const evaluationMarker = "__eveExternalPlanMutationDefinitionExecuted__";
    const globals = globalThis as Record<string, unknown>;
    delete globals[evaluationMarker];
    const app = await scenarioApp({
      files: {
        "agent/tools/after_config.ts": [
          `globalThis[${JSON.stringify(evaluationMarker)}] = true;`,
          "export default { description: 'must not execute', execute() {} };",
          "",
        ].join("\n"),
        "node_modules/fixture-runtime/index.js": 'export const value = "first";\n',
        "node_modules/fixture-runtime/package.json": JSON.stringify({
          exports: "./index.js",
          name: "fixture-runtime",
          type: "module",
        }),
      },
      name: "external-dependency-config-bootstrap-mutation",
    });
    const packageSourcePath = join(app.appRoot, "node_modules", "fixture-runtime", "index.js");
    await writeFile(
      join(app.appRoot, "agent", "agent.ts"),
      [
        'import { writeFileSync } from "node:fs";',
        'import { value } from "fixture-runtime";',
        `writeFileSync(${JSON.stringify(packageSourcePath)}, ${JSON.stringify('export const value = "second";\n')});`,
        "export default {",
        '  model: "openai/gpt-5.4",',
        "  description: value,",
        '  build: { externalDependencies: ["fixture-runtime"] },',
        "};",
        "",
      ].join("\n"),
    );
    const discovered = await discoverAgent({
      agentRoot: join(app.appRoot, "agent"),
      appRoot: app.appRoot,
    });

    try {
      await expect(compileAgentManifest(discovered.manifest)).rejects.toThrow(
        "changed after compilation",
      );
      expect(globals[evaluationMarker]).toBeUndefined();
    } finally {
      delete globals[evaluationMarker];
    }
  });

  it("resolves subpath-only conditional exports from the selected owner, not an importer decoy", async () => {
    const app = await scenarioApp({
      files: {
        "agent/node_modules/fixture-runtime/decoy.mjs": 'export const value = "decoy";\n',
        "agent/node_modules/fixture-runtime/package.json": JSON.stringify({
          exports: { "./feature": { import: "./decoy.mjs" } },
          name: "fixture-runtime",
          type: "module",
        }),
        "node_modules/fixture-runtime/default.mjs": 'export const value = "default";\n',
        "node_modules/fixture-runtime/eve-source.ts": 'export const value = "eve-source";\n',
        "node_modules/fixture-runtime/import.mjs": 'export const value = "import";\n',
        "node_modules/fixture-runtime/package.json": JSON.stringify({
          exports: {
            "./feature": {
              "eve-source": "./eve-source.ts",
              import: "./import.mjs",
              default: "./default.mjs",
            },
          },
          name: "fixture-runtime",
          type: "module",
        }),
      },
      name: "external-dependency-conditional-subpath",
    });
    const plan = await createCompiledExternalDependencyPlan([
      {
        packageName: "fixture-runtime",
        scope: { kind: "application", nodeId: "__root__", sourceRoot: app.appRoot },
      },
    ]);
    const resolution = resolveCompiledExternalDependencyImport(plan, "fixture-runtime/feature");

    expect(resolution).toEqual({
      packageName: "fixture-runtime",
      resolvedPath: await realpath(
        join(app.appRoot, "node_modules", "fixture-runtime", "import.mjs"),
      ),
    });
    const entry = plan.entries[0]!;
    const changedConditions = structuredClone(entry);
    Reflect.set(changedConditions.conditions, 1, "default");
    Reflect.set(changedConditions.conditions, 2, "import");
    expect(createCompiledExternalDependencySemanticHash(changedConditions)).not.toBe(
      entry.semanticSha256,
    );
  });

  it("rejects a selected export whose canonical target escapes its package", async () => {
    const app = await scenarioApp({
      files: {
        "escape.mjs": 'export const value = "escaped";\n',
        "node_modules/fixture-runtime/feature.mjs": 'export const value = "safe";\n',
        "node_modules/fixture-runtime/package.json": JSON.stringify({
          exports: { "./feature": "./feature.mjs" },
          name: "fixture-runtime",
          type: "module",
        }),
      },
      name: "external-dependency-export-escape",
    });
    const plan = await createCompiledExternalDependencyPlan([
      {
        packageName: "fixture-runtime",
        scope: { kind: "application", nodeId: "__root__", sourceRoot: app.appRoot },
      },
    ]);
    const featurePath = join(app.appRoot, "node_modules", "fixture-runtime", "feature.mjs");
    await rm(featurePath);
    await symlink(join(app.appRoot, "escape.mjs"), featurePath);

    expect(() => resolveCompiledExternalDependencyImport(plan, "fixture-runtime/feature")).toThrow(
      "resolves outside compiler-selected package",
    );
  });

  it("resolves an installed npm alias through the selected package's own exports", async () => {
    const app = await scenarioApp({
      files: {
        "node_modules/alias-runtime/dist/feature.mjs": 'export const value = "aliased";\n',
        "node_modules/alias-runtime/dist/package.json": JSON.stringify({
          name: "nested-package-decoy",
          type: "module",
        }),
        "node_modules/alias-runtime/package.json": JSON.stringify({
          exports: { "./feature": { import: "./dist/feature.mjs" } },
          name: "actual-runtime",
          type: "module",
        }),
      },
      name: "external-dependency-npm-alias",
    });
    const plan = await createCompiledExternalDependencyCaptureFromPackagePath({
      packageName: "alias-runtime",
      resolvedPackagePath: join(
        app.appRoot,
        "node_modules",
        "alias-runtime",
        "dist",
        "feature.mjs",
      ),
    });

    expect(plan.entries[0]?.packages[0]?.packageName).toBe("actual-runtime");
    expect(resolveCompiledExternalDependencyImport(plan, "alias-runtime/feature")).toEqual({
      packageName: "alias-runtime",
      resolvedPath: await realpath(
        join(app.appRoot, "node_modules", "alias-runtime", "dist", "feature.mjs"),
      ),
    });
  });

  it("keeps semantic identity stable when an identical closure is relocated", async () => {
    const createFixture = async (name: string) =>
      await scenarioApp({
        files: {
          "node_modules/relocatable-runtime/index.js": "export const value = 1;\n",
          "node_modules/relocatable-runtime/package.json": JSON.stringify({
            exports: "./index.js",
            name: "relocatable-runtime",
            type: "module",
          }),
        },
        name,
      });
    const [first, second] = await Promise.all([
      createFixture("external-relocation-a"),
      createFixture("external-relocation-b"),
    ]);
    const compile = async (sourceRoot: string) =>
      await createCompiledExternalDependencyPlan([
        {
          packageName: "relocatable-runtime",
          scope: { kind: "application", nodeId: "__root__", sourceRoot },
        },
      ]);

    const [firstPlan, secondPlan] = await Promise.all([
      compile(first.appRoot),
      compile(second.appRoot),
    ]);
    expect(secondPlan.entries[0]?.semanticSha256).toBe(firstPlan.entries[0]?.semanticSha256);
  });
});
