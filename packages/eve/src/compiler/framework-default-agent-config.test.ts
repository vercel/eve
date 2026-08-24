import { describe, expect, it, vi } from "vitest";

import { createAgentSourceManifest } from "#discover/manifest.js";
import { prepareAgentConfigPhase } from "#compiler/effective-agent-source-graph.js";
import { createCompiledExternalDependencyPlanSession } from "#compiler/external-dependency-plan.js";
import { compileAgentConfig } from "#compiler/normalize-agent-config.js";
import { createAgentModuleNamespaceLoader } from "#compiler/module-namespace-loader.js";
import { frameworkAgentSourceRegistry } from "#framework-sources/registry.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";

describe("framework default agent config", () => {
  it("loads and compiles through the same selected source boundary as authored config", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "app",
      agentRoot: "/app/agent",
      appRoot: "/app",
    });
    const externalDependencyPlanSession = createCompiledExternalDependencyPlanSession();
    const context = {
      diagnostics: [],
      externalDependencyPlanSession,
      modelCatalog: {
        getByProviderModelId: vi.fn(),
        getModelLimits: vi.fn(async () => ({ contextWindowTokens: 200_000 })),
      },
      moduleLoader: createAgentModuleNamespaceLoader({
        externalDependencyPlanSession,
        registry: frameworkAgentSourceRegistry,
      }),
      registry: frameworkAgentSourceRegistry,
    };
    const prepared = await prepareAgentConfigPhase({
      context,
      externalDependencies: [],
      isRoot: true,
      manifest,
      nodeId: "__root__",
    });
    const source = prepared.candidate.source;
    if (!("sourceKind" in source) || source.sourceKind !== "module") {
      throw new Error("Expected a module config source.");
    }
    const compiled = await compileAgentConfig({ ...manifest, configModule: source }, context, {
      binding: prepared.binding,
      definition: prepared.definition,
    });

    expect(compiled.model?.id).toBe(DEFAULT_AGENT_MODEL_ID);
    expect(compiled.source).toEqual({
      exportName: undefined,
      logicalPath: "agent.ts",
      sourceId: "eve.framework-defaults:agent.ts",
      sourceKind: "module",
    });
    expect(prepared.binding.owner).toEqual({
      feature: "eve.framework-defaults",
      kind: "framework",
    });
  });
});
