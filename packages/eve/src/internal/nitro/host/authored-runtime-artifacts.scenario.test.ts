import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import type { CompiledModuleMap } from "#compiler/module-map.js";
import {
  createApplicationBuildWorkspace,
  removeApplicationBuildWorkspace,
} from "#internal/application/build-workspace.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "#internal/application/runtime-compiled-artifacts-source.js";
import { loadCompiledModuleMapFromAuthoredSource } from "#internal/authored-module-map-loader.js";
import type { MaterializedInstrumentation } from "#internal/materialized-authored-modules.js";
import {
  discardDevelopmentGeneration,
  stageDevelopmentGeneration,
} from "#internal/nitro/development-generation.js";
import { prepareProductionApplicationHost } from "#internal/nitro/host/prepare-application-host.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";

describe("authored runtime artifacts", () => {
  const scenarioApp = useScenarioApp();

  it("keeps compile-only asset imports out of equivalent development and production maps", async () => {
    const app = await scenarioApp({
      files: {
        "assets/runtime.bin": "BINARY",
        "assets/runtime.txt": "runtime text\n",
        "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.ts": [
          'import { appendFileSync } from "node:fs";',
          'import prompt from "../prompts/cse.md?raw";',
          "const logPath = process.env.EVE_TEST_INSTRUCTIONS_LOG;",
          'if (logPath == null) throw new Error("missing instructions log path");',
          'appendFileSync(logPath, "evaluated\\n");',
          "export default { content: prompt };",
          "",
        ].join("\n"),
        "agent/instrumentation.ts": [
          'import marker from "../assets/runtime.txt?raw";',
          "export default { marker };",
          "",
        ].join("\n"),
        "agent/tools/read_assets.ts": [
          'import binary from "../../assets/runtime.bin";',
          'import text from "../../assets/runtime.txt?raw";',
          "export default {",
          '  description: "Read bundled assets.",',
          "  execute: () => ({ binary, text }),",
          "};",
          "",
        ].join("\n"),
        "prompts/cse.md": "CSE system prompt\n",
      },
      installDependencies: true,
      name: "authored-runtime-assets",
    });
    const lifecycleLogPath = join(app.appRoot, "instructions-evaluations.log");
    const workspace = await createApplicationBuildWorkspace(app.appRoot);
    const foreignCwd = await mkdtemp(join(tmpdir(), "eve-foreign-cwd-"));
    const previousCwd = process.cwd();
    const previousLogPath = process.env.EVE_TEST_INSTRUCTIONS_LOG;
    process.env.EVE_TEST_INSTRUCTIONS_LOG = lifecycleLogPath;
    let developmentGeneration: Awaited<ReturnType<typeof stageDevelopmentGeneration>> | undefined;

    try {
      const productionHost = await prepareProductionApplicationHost(workspace);
      const manifest = productionHost.compileResult.manifest;
      const instructions = manifest.instructions.find(
        (entry) => entry.logicalPath === "instructions.ts",
      )!;
      const tool = manifest.tools.find((entry) => entry.name === "read_assets")!;
      const instrumentationSourceId = manifest.instrumentation!.sourceId;

      expect(manifest.bindings[instructions.sourceId]?.usage).toEqual({
        compile: true,
        runtimeEntry: false,
      });
      expect(await readFile(lifecycleLogPath, "utf8")).toBe("evaluated\n");

      developmentGeneration = await stageDevelopmentGeneration(productionHost.compileResult);
      const developmentMap = await loadCompiledModuleMapFromAuthoredSource({
        compiledArtifactsSource: createAuthoredSourceRuntimeCompiledArtifactsSource(
          developmentGeneration.runtimeAppRoot,
        ),
      });

      process.chdir(foreignCwd);
      const productionModulePath = join(
        workspace.host.artifactsDir,
        "compiled-artifacts-module-map.mjs",
      );
      const productionNamespace = (await import(
        `${pathToFileURL(productionModulePath).href}?scenario=foreign-cwd`
      )) as { readonly default: CompiledModuleMap };
      const productionMap = productionNamespace.default;
      const productionRoot = productionMap.nodes.__root__;
      const developmentRoot = developmentMap.nodes.__root__;
      if (productionRoot === undefined || developmentRoot === undefined) {
        throw new Error("Expected root module-map scopes.");
      }

      expect(moduleKeys(productionMap)).toEqual(moduleKeys(developmentMap));
      expect(productionRoot.modules[instructions.sourceId]).toBeUndefined();
      expect(developmentRoot.modules[instructions.sourceId]).toBeUndefined();
      expect(
        (
          productionRoot.modules[instrumentationSourceId] as {
            readonly default: { readonly marker: string };
          }
        ).default.marker,
      ).toBe("runtime text\n");
      expect(
        (
          developmentRoot.modules[instrumentationSourceId] as {
            readonly default: { readonly marker: string };
          }
        ).default.marker,
      ).toBe("runtime text\n");
      expect(await executeAssetTool(productionMap, tool.sourceId)).toEqual({
        binary: "data:application/octet-stream;base64,QklOQVJZ",
        text: "runtime text\n",
      });
      expect(await executeAssetTool(developmentMap, tool.sourceId)).toEqual(
        await executeAssetTool(productionMap, tool.sourceId),
      );
      expect(await readFile(lifecycleLogPath, "utf8")).toBe("evaluated\n");
    } finally {
      process.chdir(previousCwd);
      if (previousLogPath === undefined) delete process.env.EVE_TEST_INSTRUCTIONS_LOG;
      else process.env.EVE_TEST_INSTRUCTIONS_LOG = previousLogPath;
      if (developmentGeneration !== undefined) {
        await discardDevelopmentGeneration(developmentGeneration);
      }
      await Promise.all([
        removeApplicationBuildWorkspace(workspace),
        rm(foreignCwd, { force: true, recursive: true }),
      ]);
    }
  });

  it("prepares provider-directory instrumentation identically for development and production", async () => {
    const app = await scenarioApp({
      files: {
        "agent/agent.ts": [
          "export default {",
          '  model: "openai/gpt-5.4",',
          "  experimental: { instrumentationProviders: true },",
          "};",
          "",
        ].join("\n"),
        "agent/instrumentation/otel.ts": [
          'import marker from "../../assets/provider.txt?raw";',
          "export default { marker };",
          "",
        ].join("\n"),
        "agent/instructions.md": "Use the configured model.\n",
        "assets/provider.txt": "provider asset\n",
      },
      name: "provider-runtime-assets",
    });
    const workspace = await createApplicationBuildWorkspace(app.appRoot);
    let developmentGeneration: Awaited<ReturnType<typeof stageDevelopmentGeneration>> | undefined;

    try {
      const productionHost = await prepareProductionApplicationHost(workspace);
      const productionProviderPath =
        productionHost.compiledArtifacts.instrumentationSourcePaths?.[0];
      expect(productionProviderPath).toBe(
        join(workspace.host.artifactsDir, "compiled-artifacts-instrumentation-otel.mjs"),
      );
      expect(productionProviderPath).not.toContain(join(app.appRoot, "agent", "instrumentation"));

      developmentGeneration = await stageDevelopmentGeneration(productionHost.compileResult);
      const compileRoot = join(developmentGeneration.runtimeAppRoot, ".eve", "compile");
      const index = JSON.parse(
        await readFile(join(compileRoot, "authored-modules.json"), "utf8"),
      ) as { readonly instrumentation?: MaterializedInstrumentation };
      expect(index.instrumentation?.kind).toBe("directory");
      if (index.instrumentation?.kind !== "directory") {
        throw new Error("Expected provider-directory instrumentation.");
      }
      const developmentProviderPath = join(
        compileRoot,
        index.instrumentation.modulePathsBySlot.otel!,
      );
      const [productionProvider, developmentProvider] = await Promise.all([
        import(`${pathToFileURL(productionProviderPath!).href}?target=production`),
        import(`${pathToFileURL(developmentProviderPath).href}?target=development`),
      ]);

      expect(productionProvider.default.marker).toBe("provider asset\n");
      expect(developmentProvider.default.marker).toBe(productionProvider.default.marker);
    } finally {
      if (developmentGeneration !== undefined) {
        await discardDevelopmentGeneration(developmentGeneration);
      }
      await removeApplicationBuildWorkspace(workspace);
    }
  });
});

function moduleKeys(moduleMap: CompiledModuleMap): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(moduleMap.nodes).map(([nodeId, node]) => [
      nodeId,
      Object.keys(node.modules).sort(),
    ]),
  );
}

async function executeAssetTool(moduleMap: CompiledModuleMap, sourceId: string): Promise<unknown> {
  const namespace = moduleMap.nodes.__root__?.modules[sourceId] as
    | { readonly default?: { readonly execute?: () => unknown } }
    | undefined;
  if (namespace?.default?.execute === undefined) throw new Error("Asset tool is not executable.");
  return await namespace.default.execute();
}
