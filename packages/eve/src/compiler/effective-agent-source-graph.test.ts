import { describe, expect, it, vi } from "vitest";

import { createFrameworkAgentSourceRegistry } from "#compiler/agent-source-registry.js";
import {
  composeAgentConfigSources,
  composeRemainingAgentSources,
  finalizeDisabledSources,
  mergeEffectiveAgentSourceGraphs,
  prepareAgentConfigPhase,
} from "#compiler/effective-agent-source-graph.js";
import { createCompiledExternalDependencyPlanSession } from "#compiler/external-dependency-plan.js";
import { defineProgrammaticAgentSource } from "#compiler/programmatic-agent-source.js";
import { createAgentModuleNamespaceLoader } from "#compiler/module-namespace-loader.js";
import type { CompiledModuleBacking } from "#compiler/module-binding.js";
import {
  createAgentSourceManifest,
  createLocalSubagentSourceRef,
  createModuleSourceRef,
  createSkillPackageSourceRef,
} from "#discover/manifest.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { frameworkAgentSourceRegistry } from "#framework-sources/registry.js";

describe("effective agent source graph", () => {
  it("selects the framework config for every local node without eager evaluation", () => {
    const loadDefault = vi.fn(() => ({ default: { model: "openai/gpt-5.5" } }));
    const source = defineProgrammaticAgentSource({
      id: "eve.defaults",
      revision: "test-revision",
      modules: [{ logicalPath: "agent.ts", loadNamespace: loadDefault }],
    });
    const registry = createFrameworkAgentSourceRegistry({
      frameworkDefaultConfigSource: source,
      registrations: [{ applyTo: "all-local-nodes", source }],
    });

    for (const [isRoot, nodeId] of [
      [true, "__root__"],
      [false, "research"],
    ] as const) {
      const graph = composeAgentConfigSources({
        externalDependencies: [],
        isRoot,
        manifest: createAgentSourceManifest({ agentRoot: "/app/agent", appRoot: "/app" }),
        nodeId,
        registry,
      });
      expect(graph.winners).toHaveLength(1);
      expect(graph.winners[0]).toMatchObject({
        descriptor: {
          owner: { feature: "eve.defaults", kind: "framework" },
          sourceId: "eve.defaults:agent.ts",
        },
        kind: "config",
        slot: "agent",
      });
      expect(graph.bindings["eve.defaults:agent.ts"]).toMatchObject({
        logicalPath: "agent.ts",
        owner: { feature: "eve.defaults", kind: "framework" },
      });
    }
    expect(loadDefault).not.toHaveBeenCalled();
  });

  it("evaluates an authored config replacement without loading the framework loser", async () => {
    const loadDefault = vi.fn(() => {
      throw new Error("shadowed config must remain lazy");
    });
    const source = defineProgrammaticAgentSource({
      id: "eve.defaults",
      revision: "test-revision",
      modules: [{ logicalPath: "agent.ts", loadNamespace: loadDefault }],
    });
    const registry = createFrameworkAgentSourceRegistry({
      frameworkDefaultConfigSource: source,
      registrations: [{ applyTo: "all-local-nodes", source }],
    });
    const manifest = createAgentSourceManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      configModule: createModuleSourceRef({
        logicalPath: "agent.ts",
        sourceId: "application-agent-config",
      }),
    });
    const registryLoader = createAgentModuleNamespaceLoader({ registry });
    const loadWinner = vi.fn(async (backing: CompiledModuleBacking) =>
      backing.kind === "programmatic"
        ? await registryLoader.load(backing)
        : { default: { model: "openai/gpt-5.5" } },
    );
    const prepared = await prepareAgentConfigPhase({
      context: {
        diagnostics: [],
        externalDependencyPlanSession: createCompiledExternalDependencyPlanSession(),
        modelCatalog: {
          getByProviderModelId: vi.fn(),
          getModelLimits: vi.fn(),
        },
        moduleLoader: { load: loadWinner },
        registry,
      },
      externalDependencies: [],
      isRoot: true,
      manifest,
      nodeId: "__root__",
    });
    const graph = prepared.graph;

    expect(loadWinner).toHaveBeenCalledOnce();
    expect(prepared.definition).toEqual({ model: "openai/gpt-5.5" });

    expect(graph.winners).toHaveLength(1);
    expect(graph.winners[0]?.descriptor.sourceId).toBe("application-agent-config");
    expect(graph.bindings).toHaveProperty("application-agent-config");
    expect(graph.bindings).not.toHaveProperty("eve.defaults:agent.ts");
    expect(graph.composition.shadowed).toEqual([
      expect.objectContaining({
        slot: "agent",
        source: expect.objectContaining({ sourceId: "eve.defaults:agent.ts" }),
        winningSourceId: "application-agent-config",
      }),
    ]);
    expect(loadDefault).not.toHaveBeenCalled();
  });

  it("composes every layer into one projected slot without binding a loser", () => {
    const loadFramework = vi.fn(() => {
      throw new Error("the losing namespace must stay lazy");
    });
    const frameworkSource = defineProgrammaticAgentSource({
      id: "eve.defaults",
      revision: "test-revision",
      modules: [
        { loadNamespace: () => ({ default: {} }), logicalPath: "agent.ts" },
        {
          loadNamespace: loadFramework,
          logicalPath: "tools/crm__search.ts",
        },
      ],
    });
    const registry = createFrameworkAgentSourceRegistry({
      frameworkDefaultConfigSource: frameworkSource,
      registrations: [{ applyTo: "all-local-nodes", source: frameworkSource }],
    });
    const extensionManifest = createAgentSourceManifest({
      agentId: "crm-extension",
      agentRoot: "/packages/crm/agent",
      appRoot: "/packages/crm",
      tools: [createModuleSourceRef({ logicalPath: "tools/search.ts", sourceId: "package-tool" })],
    });
    const overrideManifest = createAgentSourceManifest({
      agentId: "crm-override",
      agentRoot: "/app/agent/extensions/crm",
      appRoot: "/app",
      tools: [createModuleSourceRef({ logicalPath: "tools/search.ts", sourceId: "override-tool" })],
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      extensions: [createModuleSourceRef({ logicalPath: "extensions/crm.ts" })],
      resolvedExtensions: [
        {
          externalDependencies: [],
          manifest: extensionManifest,
          namespace: "crm",
          overrides: overrideManifest,
          packageName: "@acme/crm",
          packageRoot: "/packages/crm",
          sourceRoot: "/packages/crm/agent",
          specifier: "@acme/crm",
        },
      ],
      tools: [
        createModuleSourceRef({
          logicalPath: "tools/crm__search.ts",
          sourceId: "application-tool",
        }),
      ],
    });

    const graph = composeRemainingAgentSources({
      externalDependencies: ["sharp"],
      isRoot: true,
      manifest,
      nodeId: "__root__",
      registry,
    });
    const winner = graph.winners.find((candidate) => candidate.slot === "tools/crm__search");

    expect(winner?.descriptor).toMatchObject({
      layer: "application",
      logicalPath: "tools/crm__search.ts",
      owner: { kind: "application" },
      sourceId: "application-tool",
    });
    expect(graph.composition.shadowed).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({ layer: "framework-default" }),
        winningSourceId: "application-tool",
      }),
      expect.objectContaining({
        source: expect.objectContaining({
          layer: "extension-package",
          logicalPath: "tools/crm__search.ts",
        }),
        winningSourceId: "application-tool",
      }),
      expect.objectContaining({
        source: expect.objectContaining({
          layer: "extension-override",
          logicalPath: "tools/crm__search.ts",
        }),
        winningSourceId: "application-tool",
      }),
    ]);
    expect(graph.bindings).toEqual({
      "application-tool": {
        backing: {
          externalDependencies: ["sharp"],
          kind: "filesystem",
          sourcePath: "/app/agent/tools/crm__search.ts",
        },
        logicalPath: "tools/crm__search.ts",
        owner: { kind: "application" },
      },
      "extensions/crm.ts": expect.any(Object),
    });
    const composedEntry = graph.entries.find((entry) => entry.slot === "tools/crm__search");
    expect(composedEntry?.candidates.map((candidate) => candidate.descriptor.layer)).toEqual([
      "framework-default",
      "extension-package",
      "extension-override",
      "application",
    ]);

    const overrideGraph = composeRemainingAgentSources({
      externalDependencies: ["sharp"],
      isRoot: true,
      manifest: { ...manifest, tools: [] },
      nodeId: "__root__",
      registry,
    });
    expect(
      overrideGraph.winners.find((candidate) => candidate.slot === "tools/crm__search")?.descriptor,
    ).toMatchObject({
      layer: "extension-override",
      owner: { kind: "application" },
      sourceId: "ext-override:crm:override-tool",
    });

    const disabled = finalizeDisabledSources(graph, new Set(["application-tool"]));
    expect(disabled.entries).toBe(graph.entries);
    expect(disabled.bindings).not.toHaveProperty("application-tool");
    expect(disabled.composition.disabled).toEqual([
      { slot: "tools/crm__search", source: composedEntry?.winner.descriptor },
    ]);
    expect(disabled.composition.shadowed.map((entry) => entry.source)).toEqual(
      composedEntry?.candidates.slice(0, -1).map((candidate) => candidate.descriptor),
    );
    expect(disabled.composition.shadowed).toEqual(
      expect.arrayContaining([expect.objectContaining({ winningSourceId: "application-tool" })]),
    );
    expect(loadFramework).not.toHaveBeenCalled();
  });

  it("preserves projected non-module identity and physical skill package backing", () => {
    const extensionManifest = createAgentSourceManifest({
      agentId: "crm-extension",
      agentRoot: "/packages/crm/agent",
      appRoot: "/packages/crm",
      instructions: [
        {
          definition: defineInstructions({ content: "Use CRM context." }),
          logicalPath: "instructions.md",
          sourceId: "opaque-instructions",
          sourceKind: "markdown",
        },
      ],
      skills: [
        createSkillPackageSourceRef({
          description: "Review CRM records.",
          logicalPath: "skills/review",
          markdown: "# Review",
          name: "review",
          rootPath: "/packages/crm/agent/skills/review",
          skillFilePath: "/packages/crm/agent/skills/review/SKILL.md",
          skillId: "review",
          sourceId: "opaque-skill",
        }),
      ],
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      extensions: [createModuleSourceRef({ logicalPath: "extensions/crm.ts" })],
      resolvedExtensions: [
        {
          externalDependencies: [],
          manifest: extensionManifest,
          namespace: "crm",
          packageName: "@acme/crm",
          packageRoot: "/packages/crm",
          sourceRoot: "/packages/crm/agent",
          specifier: "@acme/crm",
        },
      ],
    });

    const graph = composeRemainingAgentSources({
      externalDependencies: [],
      isRoot: true,
      manifest,
      nodeId: "__root__",
    });
    const instructions = graph.winners.find((candidate) => candidate.kind === "instructions");
    const skill = graph.winners.find((candidate) => candidate.kind === "skill");

    expect(instructions).toMatchObject({
      publicName: "crm__instructions",
      source: { logicalPath: "instructions/crm__instructions.md" },
      sourcePath: "/packages/crm/agent/instructions.md",
    });
    expect(skill).toMatchObject({
      publicName: "crm__review",
      source: {
        logicalPath: "skills/crm__review",
        skillFilePath: "/packages/crm/agent/skills/review/SKILL.md",
      },
      sourcePath: "/packages/crm/agent/skills/review/SKILL.md",
    });
  });

  it("composes extension instrumentation into the canonical provider slot", () => {
    const extensionManifest = createAgentSourceManifest({
      agentId: "telemetry-extension",
      agentRoot: "/packages/telemetry/agent",
      appRoot: "/packages/telemetry",
      instrumentation: {
        providers: [
          createModuleSourceRef({
            logicalPath: "instrumentation/local.ts",
            sourceId: "extension-local",
          }),
        ],
      },
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      extensions: [createModuleSourceRef({ logicalPath: "extensions/telemetry.ts" })],
      resolvedExtensions: [
        {
          externalDependencies: [],
          manifest: extensionManifest,
          namespace: "telemetry",
          packageName: "@acme/telemetry",
          packageRoot: "/packages/telemetry",
          sourceRoot: "/packages/telemetry/agent",
          specifier: "@acme/telemetry",
        },
      ],
    });

    const graph = composeRemainingAgentSources({
      externalDependencies: [],
      instrumentationProvidersEnabled: true,
      isRoot: true,
      manifest,
      nodeId: "__root__",
      registry: frameworkAgentSourceRegistry,
    });
    const winner = graph.winners.find((candidate) => candidate.slot === "instrumentation/local");

    expect(winner).toMatchObject({
      descriptor: {
        backing: {
          sourcePath: "/packages/telemetry/agent/instrumentation/local.ts",
        },
        layer: "extension-package",
        logicalPath: "instrumentation/local.ts",
        owner: {
          kind: "extension",
          namespace: "telemetry",
          packageName: "@acme/telemetry",
        },
        sourceId: "ext:telemetry:extension-local",
      },
    });
    expect(
      graph.composition.shadowed.find((source) => source.slot === "instrumentation/local"),
    ).toMatchObject({
      source: { layer: "framework-default" },
      winningSourceId: "ext:telemetry:extension-local",
    });
  });

  it("does not lift instrumentation out of an extension subagent", () => {
    const subagentManifest = createAgentSourceManifest({
      agentId: "reviewer",
      agentRoot: "/packages/telemetry/agent/subagents/reviewer",
      appRoot: "/packages/telemetry",
      instrumentation: {
        file: createModuleSourceRef({ logicalPath: "instrumentation.ts" }),
        providers: [],
      },
    });
    const extensionManifest = createAgentSourceManifest({
      agentId: "telemetry-extension",
      agentRoot: "/packages/telemetry/agent",
      appRoot: "/packages/telemetry",
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: "/packages/telemetry/agent/subagents/reviewer/agent.ts",
          logicalPath: "subagents/reviewer",
          manifest: subagentManifest,
          rootPath: "/packages/telemetry/agent/subagents/reviewer",
          subagentId: "reviewer",
        }),
      ],
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      extensions: [createModuleSourceRef({ logicalPath: "extensions/telemetry.ts" })],
      resolvedExtensions: [
        {
          externalDependencies: [],
          manifest: extensionManifest,
          namespace: "telemetry",
          packageName: "@acme/telemetry",
          packageRoot: "/packages/telemetry",
          sourceRoot: "/packages/telemetry/agent",
          specifier: "@acme/telemetry",
        },
      ],
    });

    const graph = composeRemainingAgentSources({
      externalDependencies: [],
      isRoot: true,
      manifest,
      nodeId: "__root__",
      registry: frameworkAgentSourceRegistry,
    });

    expect(
      graph.entries
        .flatMap((entry) => entry.candidates)
        .filter(
          (candidate) =>
            candidate.kind === "instrumentation" && candidate.descriptor.owner.kind === "extension",
        ),
    ).toEqual([]);
  });

  it("does not admit root-only sources from an extension mounted by a child", () => {
    const extensionManifest = createAgentSourceManifest({
      agentId: "host-extension",
      agentRoot: "/packages/host/agent",
      appRoot: "/packages/host",
      channels: [
        createModuleSourceRef({ logicalPath: "channels/webhook.ts", sourceId: "host-channel" }),
      ],
      instrumentation: {
        providers: [
          createModuleSourceRef({
            logicalPath: "instrumentation/local.ts",
            sourceId: "host-instrumentation",
          }),
        ],
      },
      schedules: [
        createModuleSourceRef({ logicalPath: "schedules/daily.ts", sourceId: "host-schedule" }),
      ],
    });
    const manifest = createAgentSourceManifest({
      agentId: "research",
      agentRoot: "/app/agent/subagents/research",
      appRoot: "/app",
      extensions: [createModuleSourceRef({ logicalPath: "extensions/host.ts" })],
      resolvedExtensions: [
        {
          externalDependencies: [],
          manifest: extensionManifest,
          namespace: "host",
          packageName: "@acme/host",
          packageRoot: "/packages/host",
          sourceRoot: "/packages/host/agent",
          specifier: "@acme/host",
        },
      ],
    });

    const graph = composeRemainingAgentSources({
      externalDependencies: [],
      instrumentationProvidersEnabled: true,
      isRoot: false,
      manifest,
      nodeId: "research",
    });

    expect(graph.winners.some((candidate) => candidate.kind === "extension-mount")).toBe(true);
    expect(
      graph.entries
        .flatMap((entry) => entry.candidates)
        .filter((candidate) => ["channel", "instrumentation", "schedule"].includes(candidate.kind)),
    ).toEqual([]);
  });

  it("rejects a source id collision between config and remaining phases", () => {
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      configModule: createModuleSourceRef({ logicalPath: "agent.ts", sourceId: "opaque" }),
      tools: [createModuleSourceRef({ logicalPath: "tools/read.ts", sourceId: "opaque" })],
    });
    const config = composeAgentConfigSources({
      externalDependencies: [],
      isRoot: true,
      manifest,
      nodeId: "__root__",
    });
    const remaining = composeRemainingAgentSources({
      externalDependencies: [],
      isRoot: true,
      manifest,
      nodeId: "__root__",
    });

    expect(() => mergeEffectiveAgentSourceGraphs(config, remaining)).toThrow(
      'both contain source id "opaque" before normalization',
    );
  });

  it("rejects duplicate source ids inside one remaining graph", () => {
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      tools: [
        createModuleSourceRef({ logicalPath: "tools/read.ts", sourceId: "opaque" }),
        createModuleSourceRef({ logicalPath: "tools/write.ts", sourceId: "opaque" }),
      ],
    });

    expect(() =>
      composeRemainingAgentSources({
        externalDependencies: [],
        isRoot: true,
        manifest,
        nodeId: "__root__",
      }),
    ).toThrow('identifies both "tools/read.ts" and "tools/write.ts"');
  });
});
