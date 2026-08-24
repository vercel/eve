import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AgentInfoResultSchema, type AgentInfoResult } from "../../src/client/agent-info-schema.js";
import { resolveCompilerArtifactPaths } from "../../src/compiler/artifacts.js";
import { compileAgent } from "../../src/compiler/compile-agent.js";
import { resolvePackageSourceFilePath } from "../../src/internal/application/package.js";
import {
  discardDevelopmentGeneration,
  stageDevelopmentGeneration,
} from "../../src/internal/nitro/development-generation.js";
import { buildAgentInfoResponse } from "../../src/internal/nitro/routes/agent-info/build-agent-info-response.js";
import {
  loadAgentInfoManifestData,
  resolveAgentInfoCompiledArtifactsSource,
} from "../../src/internal/nitro/routes/agent-info/load-agent-info-data.js";
import { createDiskRuntimeCompiledArtifactsSource } from "../../src/runtime/compiled-artifacts-source.js";
import { installBundledCompiledArtifacts } from "../../src/runtime/loaders/bundled-artifacts.js";
import { loadCompiledManifest } from "../../src/runtime/loaders/manifest.js";
import { loadCompiledModuleMap } from "../../src/runtime/loaders/module-map.js";
import { loadCompilerDiagnosticsArtifact } from "../../src/runtime/loaders/compiler-diagnostics.js";
import {
  createRuntimeSession,
  withRuntimeSession,
} from "../../src/runtime/sessions/runtime-session.js";
import { useTemporaryAppRoots } from "../../src/internal/testing/use-temporary-app-roots.js";

const createAppRoot = useTemporaryAppRoots();

const APP_ROOT_OPTIONS = { packageName: "agent-info-data-test-agent" } as const;

describe("loadAgentInfoManifestData", () => {
  it("projects the same portable semantics from dev disk and a production bundle", async () => {
    const { agentRoot, appRoot } = await createAppRoot("eve-agent-info-data-", APP_ROOT_OPTIONS);

    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");
    await mkdir(join(agentRoot, "subagents", "dynamic"), { recursive: true });
    await writeFile(
      join(agentRoot, "subagents", "dynamic", "agent.mjs"),
      [
        "export default {",
        '  kind: "eve:dynamic",',
        "  events: {",
        '    "session.started": () => ({',
        '      description: "Dynamic local assistant.",',
        '      model: "openai/gpt-5.4",',
        "    }),",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await mkdir(join(agentRoot, "subagents", "local"), { recursive: true });
    await writeFile(
      join(agentRoot, "subagents", "local", "agent.mjs"),
      [
        "export default {",
        '  description: "Static local assistant.",',
        '  model: "openai/gpt-5.4",',
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(agentRoot, "subagents", "remote.mjs"),
      [
        "export default {",
        '  description: "Remote assistant.",',
        '  kind: "remote",',
        '  path: "/eve/v1/session",',
        '  url: "https://remote.example.com",',
        "};",
        "",
      ].join("\n"),
    );
    await mkdir(join(agentRoot, "sandbox"), {
      recursive: true,
    });
    await writeFile(
      join(agentRoot, "sandbox", "sandbox.ts"),
      ["export default {};", ""].join("\n"),
    );

    const compileResult = await compileAgent({
      startPath: appRoot,
    });

    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);
    const paths = resolveCompilerArtifactPaths(appRoot);
    const [manifest, moduleMap] = await Promise.all([
      loadCompiledManifest({
        compiledArtifactsSource,
      }),
      loadCompiledModuleMap({
        compiledArtifactsSource,
      }),
    ]);
    const diagnostics = await loadCompilerDiagnosticsArtifact({
      compiledArtifactsSource,
      manifest,
    });
    const generation = await stageDevelopmentGeneration(compileResult);

    try {
      await withRuntimeSession(createRuntimeSession("agent-info-data-test"), async () => {
        installBundledCompiledArtifacts({
          diagnostics,
          manifest: compileResult.manifest,
          metadata: compileResult.metadata,
          moduleMap,
        });

        await rm(paths.compileDirectoryPath, {
          force: true,
          recursive: true,
        });

        const developmentArtifactsSource = createDiskRuntimeCompiledArtifactsSource(
          generation.runtimeAppRoot,
          {
            moduleMapLoaderKind: "materialized-generation",
            moduleMapLoaderPath: resolvePackageSourceFilePath(
              "src/internal/authored-module-map-loader.ts",
            ),
          },
        );
        const productionArtifactsSource = resolveAgentInfoCompiledArtifactsSource({
          kind: "production",
        });
        expect(productionArtifactsSource.kind).toBe("bundled");

        const [developmentData, productionData] = await Promise.all([
          loadAgentInfoManifestData({ compiledArtifactsSource: developmentArtifactsSource }),
          loadAgentInfoManifestData({ compiledArtifactsSource: productionArtifactsSource }),
        ]);
        const developmentInfo = AgentInfoResultSchema.parse(
          buildAgentInfoResponse(developmentData, {
            gatewayCredentials: { apiKey: false, oidc: false },
            mode: "development",
          }),
        );
        const productionInfo = AgentInfoResultSchema.parse(
          buildAgentInfoResponse(productionData, {
            gatewayCredentials: { apiKey: false, oidc: false },
            mode: "production",
          }),
        );

        expect(developmentInfo).toMatchObject({
          capabilities: { devRoutes: true },
          mode: "development",
        });
        expect(productionInfo).toMatchObject({
          capabilities: { devRoutes: false },
          mode: "production",
        });
        expect(developmentInfo.agent.agentRoot).not.toBe(productionInfo.agent.agentRoot);
        expect(developmentInfo.subagents.total).toBe(2);
        expect(developmentInfo.remoteAgents.total).toBe(1);
        expect(
          developmentInfo.subagents.local.find((entry) => entry.name === "local")?.description,
        ).toBe("Static local assistant.");
        expect(
          productionInfo.subagents.local.find((entry) => entry.name === "local")?.description,
        ).toBe("Static local assistant.");
        expect(developmentInfo.subagents.local.map((entry) => entry.rootPath)).not.toEqual(
          productionInfo.subagents.local.map((entry) => entry.rootPath),
        );
        expect(developmentInfo.remoteAgents.entries.map((entry) => entry.rootPath)).not.toEqual(
          productionInfo.remoteAgents.entries.map((entry) => entry.rootPath),
        );
        expect(toPortableAgentInfoSemantics(developmentInfo)).toEqual(
          toPortableAgentInfoSemantics(productionInfo),
        );

        expect(productionData.manifest.config.name).toBe(manifest.config.name);
        const staticLocal = manifest.subagents.find((entry) => entry.name === "local");
        expect(staticLocal?.agent.sourceComposition.shadowed).toContainEqual(
          expect.objectContaining({
            slot: "agent",
            source: expect.objectContaining({
              sourceId: "eve.framework-defaults:agent.ts",
            }),
            winningSourceId: "agent.mjs",
          }),
        );
        expect(productionData.manifest.sandbox.sourceKind).toBe("module");
        expect(productionData.manifest.schedules).toEqual([]);
      });
    } finally {
      await discardDevelopmentGeneration(generation);
    }
  });
});

function toPortableAgentInfoSemantics(result: AgentInfoResult) {
  const { capabilities: _capabilities, mode: _mode, ...semanticResult } = result;
  const { agentRoot: _agentRoot, appRoot: _appRoot, ...agent } = semanticResult.agent;
  return {
    ...semanticResult,
    agent,
    remoteAgents: {
      ...semanticResult.remoteAgents,
      entries: semanticResult.remoteAgents.entries.map(stripAgentFilesystemPaths),
    },
    subagents: {
      ...semanticResult.subagents,
      local: semanticResult.subagents.local.map(stripAgentFilesystemPaths),
    },
  };
}

function stripAgentFilesystemPaths<
  Entry extends { readonly entryPath: string; readonly rootPath: string },
>({ entryPath: _entryPath, rootPath: _rootPath, ...entry }: Entry) {
  return entry;
}
