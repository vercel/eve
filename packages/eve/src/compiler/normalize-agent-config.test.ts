import { describe, expect, it, vi } from "vitest";

import { createAgentSourceManifest, createModuleSourceRef } from "#discover/manifest.js";
import { defineDynamic } from "#public/definitions/tool.js";
import { chatgpt } from "#public/models/openai/index.js";
import { compileAgentConfig } from "#compiler/normalize-agent-config.js";
import { createCompiledExternalDependencyPlanSession } from "#compiler/external-dependency-plan.js";
import type { ManifestCompileContext } from "#compiler/normalize-helpers.js";

describe("compileAgentConfig", () => {
  it("compiles a dynamic model resolver without a model reference", async () => {
    const definition = {
      model: defineDynamic({
        events: {
          "session.started": () => "openai/gpt-5.5-mini",
          "step.started": () => "openai/gpt-5.5",
        },
      }),
    };

    const manifest = createAgentSourceManifest({
      agentId: "app",
      agentRoot: "/app/agent",
      appRoot: "/app",
      configModule: createModuleSourceRef({
        logicalPath: "agent.ts",
        sourceId: "agent-config",
      }),
    });

    const modelCatalog = createModelCatalog();
    const compiled = await compileAgentConfig(manifest, createContext(modelCatalog), {
      binding: createConfigBinding(),
      definition,
    });

    expect(compiled.model).toBeUndefined();
    expect(compiled.dynamicModel).toEqual({
      eventNames: ["session.started", "step.started"],
      logicalPath: "agent.ts",
      sourceId: "agent-config",
      sourceKind: "module",
    });
    expect(modelCatalog.getModelLimits).not.toHaveBeenCalled();
  });

  it("rejects unsupported dynamic model event keys", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "app",
      agentRoot: "/app/agent",
      appRoot: "/app",
      configModule: createModuleSourceRef({ logicalPath: "agent.ts", sourceId: "agent-config" }),
    });

    await expect(
      compileAgentConfig(manifest, createContext(createModelCatalog()), {
        binding: createConfigBinding(),
        definition: {
          model: {
            events: { "message.delta": () => "openai/gpt-5.5" },
            kind: "eve:dynamic",
          } as never,
        },
      }),
    ).rejects.toThrow('Unsupported event: "message.delta"');
  });

  it("derives a filesystem config locator from the selected binding backing", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "researcher",
      agentRoot: "/app/agent/subagents/researcher",
      appRoot: "/app",
      configModule: createModuleSourceRef({
        logicalPath: "agent.ts",
        sourceId: "agent-config",
      }),
    });
    const binding = createFilesystemConfigBinding("/app/agent/generated/researcher-config.ts");

    await expect(
      compileAgentConfig(manifest, createContext(createModelCatalog()), {
        binding,
        definition: { model: 42 },
      }),
    ).rejects.toThrow('from "generated/researcher-config.ts"');
  });

  it("compiles an eve-owned Codex model without AI Gateway metadata", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "app",
      agentRoot: "/app/agent",
      appRoot: "/app",
      configModule: createModuleSourceRef({ logicalPath: "agent.ts", sourceId: "agent-config" }),
    });
    const modelCatalog = createModelCatalog();

    const compiled = await compileAgentConfig(manifest, createContext(modelCatalog), {
      binding: createConfigBinding(),
      definition: { model: chatgpt("gpt-5.6-sol") },
    });

    expect(compiled.model).toEqual(
      expect.objectContaining({
        id: "codex/gpt-5.6-sol",
        routing: { kind: "external", provider: "codex" },
        contextWindowTokens: 200_000,
      }),
    );
    expect(modelCatalog.getByProviderModelId).not.toHaveBeenCalled();
    expect(modelCatalog.getModelLimits).not.toHaveBeenCalled();
  });

  it("compiles an injected agent definition without reloading agent.ts", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "researcher",
      agentRoot: "/app/agent/subagents/researcher",
      appRoot: "/app",
      configModule: createModuleSourceRef({
        logicalPath: "agent.ts",
        sourceId: "agent-config",
      }),
    });

    const compiled = await compileAgentConfig(manifest, createContext(createModelCatalog()), {
      binding: createConfigBinding(),
      definition: {
        model: "openai/gpt-5.5",
      },
    });

    expect(compiled.description).toBeUndefined();
    expect(compiled.source.sourceId).toBe("agent-config");
  });

  it("rejects a selected binding for a different logical path", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "app",
      agentRoot: "/app/agent",
      appRoot: "/app",
      configModule: createModuleSourceRef({ logicalPath: "agent.ts", sourceId: "agent-config" }),
    });

    await expect(
      compileAgentConfig(manifest, createContext(createModelCatalog()), {
        binding: { ...createConfigBinding(), logicalPath: "tools/config.ts" },
        definition: { model: "openai/gpt-5.5" },
      }),
    ).rejects.toThrow('targets "tools/config.ts" instead of "agent.ts"');
  });

  it("uses a programmatic config backing locator when an injected definition is invalid", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "app",
      agentRoot: "/app/agent",
      appRoot: "/app",
      configModule: createModuleSourceRef({ logicalPath: "agent.ts", sourceId: "agent-config" }),
    });

    await expect(
      compileAgentConfig(manifest, createContext(createModelCatalog()), {
        binding: createConfigBinding(),
        definition: { model: 42 },
      }),
    ).rejects.toThrow('from "test:agent.ts"');
  });
});

function createModelCatalog(): ManifestCompileContext["modelCatalog"] {
  return {
    getByProviderModelId: vi.fn(),
    getModelLimits: vi.fn(async () => ({ contextWindowTokens: 256_000 })),
  };
}

function createContext(
  modelCatalog: ManifestCompileContext["modelCatalog"],
): ManifestCompileContext {
  return {
    diagnostics: [],
    externalDependencyPlanSession: createCompiledExternalDependencyPlanSession(),
    modelCatalog,
    moduleLoader: { load: vi.fn() },
  };
}

function createConfigBinding() {
  return {
    backing: {
      kind: "programmatic" as const,
      moduleId: "agent.ts",
      registryId: "test",
      revision: "test-revision",
    },
    logicalPath: "agent.ts",
    owner: { kind: "application" as const },
  };
}

function createFilesystemConfigBinding(sourcePath: string) {
  return {
    backing: { externalDependencies: [], kind: "filesystem" as const, sourcePath },
    logicalPath: "agent.ts",
    owner: { kind: "application" as const },
  };
}
