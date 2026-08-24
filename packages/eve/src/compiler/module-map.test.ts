import { describe, expect, it } from "vitest";

import { createAgentSourceRegistry } from "#compiler/agent-source-registry.js";
import { defineProgrammaticAgentSource } from "#compiler/programmatic-agent-source.js";
import type { CompiledAgentManifest } from "./manifest.js";
import {
  COMPILED_AGENT_MANIFEST_VERSION,
  createCompiledAgentResources,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "./manifest.js";
import {
  collectModuleRefsForManifest,
  createCompiledModuleMapDescriptorSource,
  createProgrammaticCompiledModuleMapIdentity,
  createProgrammaticCompiledModuleMap,
} from "./module-map.js";
import { collectCompiledModuleScopes } from "./module-scope.js";
import { createTestCompiledRemoteAgentNode } from "#internal/testing/compiled-manifest.js";

const TEST_MODULE_MAP_IDENTITY = "a".repeat(64);

function createManifestWithTool(agentRoot: string): CompiledAgentManifest {
  const configSourceId = "agent.ts";
  const sandboxSourceId = "zz-test-sandbox";
  return {
    agentRoot,
    appRoot: agentRoot,
    instrumentation: { kind: "none" },
    bindings: {
      [configSourceId]: {
        backing: {
          externalDependencies: [],
          kind: "filesystem",
          sourcePath: `${agentRoot}/agent.ts`,
        },
        logicalPath: "agent.ts",
        owner: { kind: "application" },
      },
      "tools/echo.ts": {
        backing: {
          externalDependencies: [],
          kind: "filesystem",
          sourcePath: `${agentRoot}/tools/echo.ts`,
        },
        logicalPath: "tools/echo.ts",
        owner: { kind: "application" },
      },
      [sandboxSourceId]: {
        backing: {
          externalDependencies: [],
          kind: "filesystem",
          sourcePath: `${agentRoot}/sandbox.ts`,
        },
        logicalPath: "sandbox.ts",
        owner: { kind: "application" },
      },
    },
    sourceComposition: {
      disabled: [],
      selected: [
        { slot: "agent", sourceId: configSourceId, sourceKind: "module" },
        { slot: "tools/echo", sourceId: "tools/echo.ts", sourceKind: "module" },
        { slot: "sandbox", sourceId: sandboxSourceId, sourceKind: "module" },
      ],
      shadowed: [],
    },
    config: {
      compaction: {},
      model: {
        contextWindowTokens: 128_000,
        id: "openai/gpt-5.4-mini",
        routing: { kind: "gateway", target: "openai" },
      },
      name: "kitchen-sink-fixture",
      source: { logicalPath: "agent.ts", sourceId: configSourceId, sourceKind: "module" },
    },
    connections: [],
    diagnosticsSummary: {
      errors: 0,
      warnings: 0,
    },
    externalDependencyPlan: { entries: [] },
    extensionMounts: [],
    kernelPlan: { prepared: ["agent", "ask_question", "final_output"] },
    dynamicInstructions: [],
    dynamicSkills: [],
    dynamicTools: [],
    hooks: [],
    instructions: [],
    kind: "eve-agent-compiled-manifest",
    remoteAgents: [],
    schedules: [],
    sandbox: {
      hasBootstrap: false,
      hasOnSession: false,
      logicalPath: "sandbox.ts",
      sourceHash: "test-sandbox",
      sourceId: sandboxSourceId,
      sourceKind: "module",
    },
    sandboxWorkspaces: [],
    skills: [],
    subagentEdges: [],
    channelRoutes: { effective: [], preflight: [], shadowed: [] },
    subagents: [],
    tools: [
      {
        description: "Echoes input.",
        exportName: "default",
        hasAuth: false,
        hasExecute: true,
        hasModelOutputProjection: false,
        inputSchema: {},
        logicalPath: "tools/echo.ts",
        name: "echo",
        requiresApproval: false,
        sourceId: "tools/echo.ts",
        sourceKind: "module",
      },
    ],
    version: COMPILED_AGENT_MANIFEST_VERSION,
    workflowWorld: { kind: "native", selection: "host-default", target: "local" },
    workspaceResourceRoot: {
      logicalPath: "",
      rootEntries: [],
    },
  };
}

describe("createCompiledModuleMapDescriptorSource", () => {
  it("renders bundled namespace loaders as inert dynamic imports", () => {
    const source = createCompiledModuleMapDescriptorSource({
      identity: TEST_MODULE_MAP_IDENTITY,
      importSpecifierStyle: "absolute",
      manifest: createManifestWithTool("/consumer/agent"),
      moduleMapPath: "/consumer/.eve/compile/bootstrap.mjs",
    });

    expect(source).toContain('() => import("/consumer/agent/tools/echo.ts")');
    expect(source).not.toMatch(/^import .*tools\/echo\.ts/m);
  });

  it("emits a lazy registry lookup for programmatic modules", () => {
    const manifest = createManifestWithTool("/consumer/agent");
    const source = createCompiledModuleMapDescriptorSource({
      identity: TEST_MODULE_MAP_IDENTITY,
      manifest: {
        ...manifest,
        bindings: {
          ...manifest.bindings,
          "tools/echo.ts": {
            backing: {
              kind: "programmatic",
              moduleId: "tools/echo.ts",
              registryId: "eve.defaults",
              revision: "test-revision",
            },
            logicalPath: "tools/echo.ts",
            owner: { feature: "defaults", kind: "framework" },
          },
        },
      },
      moduleMapPath: "/consumer/.eve/compile/module-map.mjs",
      programmaticRegistryImports: {
        "eve.defaults": {
          exportName: "defaultAgentSourceRegistry",
          importSpecifier: "eve/internal/default-agent-source-registry",
        },
      },
    });

    expect(source).toContain(
      'async () => (await import("eve/internal/default-agent-source-registry")).defaultAgentSourceRegistry.loadModule({"kind":"programmatic","moduleId":"tools/echo.ts","registryId":"eve.defaults","revision":"test-revision"})',
    );
    expect(source).not.toMatch(/^import /m);
    expect(source).not.toContain("/consumer/agent/tools/echo.ts");
  });

  it("knows how to import the framework source registry", () => {
    const manifest = createManifestWithTool("/consumer/agent");
    const sourceId = "eve.framework-defaults:tools/bash.ts";
    const source = createCompiledModuleMapDescriptorSource({
      identity: TEST_MODULE_MAP_IDENTITY,
      manifest: {
        ...manifest,
        bindings: {
          [manifest.config.source.sourceId]: manifest.bindings[manifest.config.source.sourceId]!,
          [manifest.sandbox.sourceId]: manifest.bindings[manifest.sandbox.sourceId]!,
          [sourceId]: {
            backing: {
              kind: "programmatic",
              moduleId: "tools/bash.ts",
              registryId: "eve.framework-defaults",
              revision: "test-revision",
            },
            logicalPath: "tools/bash.ts",
            owner: { feature: "eve.framework-defaults", kind: "framework" },
          },
        },
        sourceComposition: {
          disabled: [],
          selected: [
            ...manifest.sourceComposition.selected.filter(
              (entry) => entry.slot === "agent" || entry.slot === "sandbox",
            ),
            { slot: "tools/bash", sourceId, sourceKind: "module" },
          ],
          shadowed: [],
        },
        tools: [
          {
            ...manifest.tools[0]!,
            logicalPath: "tools/bash.ts",
            name: "bash",
            sourceId,
          },
        ],
      },
      moduleMapPath: "/consumer/.eve/compile/module-map.mjs",
    });

    expect(source).toContain(
      '.frameworkAgentSourceRegistry.loadModule({"kind":"programmatic","moduleId":"tools/bash.ts","registryId":"eve.framework-defaults","revision":"test-revision"})',
    );
  });

  it("imports root-only framework sources from the framework registry", () => {
    const manifest = createManifestWithTool("/consumer/agent");
    const sourceId = "eve.framework-root:channels/eve.ts";
    const source = createCompiledModuleMapDescriptorSource({
      identity: TEST_MODULE_MAP_IDENTITY,
      manifest: {
        ...manifest,
        bindings: {
          [manifest.config.source.sourceId]: manifest.bindings[manifest.config.source.sourceId]!,
          [manifest.sandbox.sourceId]: manifest.bindings[manifest.sandbox.sourceId]!,
          [sourceId]: {
            backing: {
              kind: "programmatic",
              moduleId: "channels/eve.ts",
              registryId: "eve.framework-root",
              revision: "test-revision",
            },
            logicalPath: "channels/eve.ts",
            owner: { feature: "eve.framework-root", kind: "framework" },
          },
        },
        sourceComposition: {
          disabled: [],
          selected: [
            ...manifest.sourceComposition.selected.filter(
              (entry) => entry.slot === "agent" || entry.slot === "sandbox",
            ),
            { slot: "channels/eve", sourceId, sourceKind: "module" },
          ],
          shadowed: [],
        },
        channelRoutes: {
          effective: [
            {
              kind: "channel",
              logicalPath: "channels/eve.ts",
              method: "POST",
              name: "eve",
              sourceId,
              sourceKind: "module",
              urlPath: "/eve/v1/session",
            },
          ],
          preflight: [],
          shadowed: [],
        },
        tools: [],
      },
      moduleMapPath: "/consumer/.eve/compile/module-map.mjs",
    });

    expect(source).toContain(
      '.frameworkAgentSourceRegistry.loadModule({"kind":"programmatic","moduleId":"channels/eve.ts","registryId":"eve.framework-root","revision":"test-revision"})',
    );
  });

  it("imports the physical binding instead of reconstructing it from logical identity", () => {
    const manifest = createManifestWithTool("/consumer/agent");
    const source = createCompiledModuleMapDescriptorSource({
      identity: TEST_MODULE_MAP_IDENTITY,
      manifest: {
        ...manifest,
        bindings: {
          ...manifest.bindings,
          "tools/echo.ts": {
            ...manifest.bindings["tools/echo.ts"]!,
            backing: {
              externalDependencies: [],
              kind: "filesystem",
              sourcePath: "/packages/framework/tools/echo.ts",
            },
          },
        },
      },
      moduleMapPath: "/consumer/.eve/compile/module-map.mjs",
    });

    expect(source).toContain('() => import("../../../packages/framework/tools/echo.ts")');
    expect(source).not.toContain("/consumer/agent/tools/echo.ts");
  });

  it("emits ESM-safe file URLs for Windows absolute imports", () => {
    const source = createCompiledModuleMapDescriptorSource({
      identity: TEST_MODULE_MAP_IDENTITY,
      importSpecifierStyle: "absolute",
      manifest: createManifestWithTool(
        "G:\\projects\\eve\\apps\\fixtures\\kitchen-sink-fixture\\agent",
      ),
      moduleMapPath:
        "G:\\projects\\eve\\apps\\fixtures\\kitchen-sink-fixture\\.eve\\compile\\module-map.mjs",
    });

    expect(source).toContain(
      '() => import("file:///G:/projects/eve/apps/fixtures/kitchen-sink-fixture/agent/tools/echo.ts")',
    );
    expect(source).not.toContain(
      '"G:/projects/eve/apps/fixtures/kitchen-sink-fixture/agent/tools/echo.ts"',
    );
    expect(source).toContain(`"${ROOT_COMPILED_AGENT_NODE_ID}"`);
  });

  it("imports a dynamic subagent config resolver relative to the child agent root", () => {
    const manifest: CompiledAgentManifest = {
      ...createManifestWithTool("/agent"),
      subagents: [
        {
          agent: createCompiledAgentResources(
            {
              agentRoot: "/agent/subagents/researcher",
              appRoot: "/agent",
              instrumentation: { kind: "none" },
              kernelPlan: { prepared: ["ask_question", "final_output"] },
              bindings: {
                "agent.ts": {
                  backing: {
                    externalDependencies: [],
                    kind: "filesystem",
                    sourcePath: "/agent/subagents/researcher/agent.ts",
                  },
                  logicalPath: "agent.ts",
                  owner: { kind: "application" },
                },
                "zz-child-test-sandbox": {
                  backing: {
                    externalDependencies: [],
                    kind: "filesystem",
                    sourcePath: "/agent/subagents/researcher/sandbox.ts",
                  },
                  logicalPath: "sandbox.ts",
                  owner: { kind: "application" },
                },
              },
              channelRoutes: { effective: [], preflight: [], shadowed: [] },
              sourceComposition: {
                disabled: [],
                selected: [
                  { slot: "agent", sourceId: "agent.ts", sourceKind: "module" },
                  {
                    slot: "sandbox",
                    sourceId: "zz-child-test-sandbox",
                    sourceKind: "module",
                  },
                ],
                shadowed: [],
              },
              sandbox: {
                hasBootstrap: false,
                hasOnSession: false,
                logicalPath: "sandbox.ts",
                sourceHash: "child-test-sandbox",
                sourceId: "zz-child-test-sandbox",
                sourceKind: "module",
              },
            },
            {
              additionalBindingReferences: [
                {
                  logicalPath: "agent.ts",
                  sourceId: "agent.ts",
                  sourceKind: "module",
                },
              ],
              isRoot: false,
              nodeId: "subagents/researcher",
            },
          ),
          backing: {
            externalDependencies: [],
            kind: "filesystem",
            sourcePath: "/agent/subagents/researcher/agent.ts",
          },
          configResolver: {
            eventNames: ["turn.started"],
            logicalPath: "agent.ts",
            sourceId: "agent.ts",
            sourceKind: "module",
          },
          entryPath: "/agent/subagents/researcher/agent.ts",
          logicalPath: "subagents/researcher",
          name: "researcher",
          nodeId: "subagents/researcher",
          owner: { kind: "application" },
          rootPath: "/agent/subagents/researcher",
          sourceId: "subagents/researcher",
          sourceKind: "subagent",
        },
      ],
    };

    const source = createCompiledModuleMapDescriptorSource({
      identity: TEST_MODULE_MAP_IDENTITY,
      manifest,
      moduleMapPath: "/agent/.eve/compile/module-map.mjs",
    });

    expect(source).toContain('() => import("../../subagents/researcher/agent.ts")');
    expect(source).not.toContain("subagents/researcher/subagents/researcher");
  });
});

describe("createProgrammaticCompiledModuleMap", () => {
  it("distinguishes same-key registrations when their callable revision changes", () => {
    const firstExecute = () => "first";
    const secondExecute = () => "second";
    const createManifest = (
      execute: () => string,
      semanticRevision?: string,
    ): CompiledAgentManifest => {
      const base = createManifestWithTool("/agent");
      const backing: {
        kind: "programmatic";
        moduleId: string;
        registryId: string;
        revision: string;
        semanticRevision?: string;
      } = {
        kind: "programmatic",
        moduleId: "tools/echo.ts",
        registryId: "eve.selected",
        revision: Function.prototype.toString.call(execute),
      };
      if (semanticRevision !== undefined) backing.semanticRevision = semanticRevision;
      return {
        ...base,
        bindings: {
          ...base.bindings,
          [base.config.source.sourceId]: {
            ...base.bindings[base.config.source.sourceId]!,
            backing: {
              kind: "programmatic",
              moduleId: "agent.ts",
              registryId: "eve.selected",
              revision: "stable-agent-revision",
            },
          },
          "zz-test-sandbox": {
            ...base.bindings["zz-test-sandbox"]!,
            backing: {
              kind: "programmatic",
              moduleId: "sandbox.ts",
              registryId: "eve.selected",
              revision: "stable-sandbox-revision",
            },
          },
          "tools/echo.ts": {
            backing,
            logicalPath: "tools/echo.ts",
            owner: { feature: "selected", kind: "framework" },
          },
        },
      };
    };

    expect(createProgrammaticCompiledModuleMapIdentity(createManifest(firstExecute))).not.toBe(
      createProgrammaticCompiledModuleMapIdentity(createManifest(secondExecute)),
    );
    expect(
      createProgrammaticCompiledModuleMapIdentity(createManifest(firstExecute, "semantic-v1")),
    ).not.toBe(
      createProgrammaticCompiledModuleMapIdentity(createManifest(firstExecute, "semantic-v2")),
    );
  });

  it("loads only the selected programmatic namespace", async () => {
    let selectedLoads = 0;
    let unselectedLoads = 0;
    const registry = createAgentSourceRegistry([
      {
        applyTo: "root",
        source: defineProgrammaticAgentSource({
          id: "eve.selected",
          revision: "selected-revision",
          modules: [
            {
              loadNamespace: () => {
                selectedLoads += 1;
                return { default: { description: "Selected" } };
              },
              logicalPath: "tools/echo.ts",
            },
          ],
        }),
      },
      {
        applyTo: "root",
        source: defineProgrammaticAgentSource({
          id: "eve.unselected",
          revision: "unselected-revision",
          modules: [
            {
              loadNamespace: () => {
                unselectedLoads += 1;
                throw new Error("unselected namespace executed");
              },
              logicalPath: "tools/unused.ts",
            },
          ],
        }),
      },
    ]);
    const base = createManifestWithTool("/agent");
    const manifest: CompiledAgentManifest = {
      ...base,
      bindings: {
        ...base.bindings,
        "tools/echo.ts": {
          backing: {
            kind: "programmatic",
            moduleId: "tools/echo.ts",
            registryId: "eve.selected",
            revision: "selected-revision",
          },
          logicalPath: "tools/echo.ts",
          owner: { feature: "selected", kind: "framework" },
        },
      },
    };

    const moduleMap = await createProgrammaticCompiledModuleMap({ manifest, registry });

    expect(moduleMap.nodes.__root__?.modules["tools/echo.ts"]).toEqual({
      default: { description: "Selected" },
    });
    expect(selectedLoads).toBe(1);
    expect(unselectedLoads).toBe(0);
  });
});

describe("collectModuleRefsForManifest", () => {
  it("includes dynamic model and compaction model sources", () => {
    const manifest = createManifestWithTool("/agent");
    const dynamicRefs = collectModuleRefsForManifest({
      ...manifest,
      config: {
        dynamicModel: {
          eventNames: ["turn.started"],
          logicalPath: "models/dynamic.ts",
          sourceId: "dynamic-model",
          sourceKind: "module",
        },
        name: "dynamic-agent",
        source: manifest.config.source,
      },
    });
    const compactionRefs = collectModuleRefsForManifest({
      ...manifest,
      config: {
        ...manifest.config,
        compaction: {
          model: {
            id: "custom/compact",
            routing: { kind: "external", provider: "custom" },
            source: {
              logicalPath: "models/compact.ts",
              sourceId: "compaction-model",
              sourceKind: "module",
            },
          },
        },
      },
    });

    expect(dynamicRefs).toContainEqual({
      logicalPath: "models/dynamic.ts",
      sourceId: "dynamic-model",
      sourceKind: "module",
    });
    expect(compactionRefs).toContainEqual({
      logicalPath: "models/compact.ts",
      sourceId: "compaction-model",
      sourceKind: "module",
    });
  });

  it("includes module-sourced schedules with run() so the dispatcher can load the handler", () => {
    const manifest = createManifestWithTool("/agent");
    const manifestWithSchedule: CompiledAgentManifest = {
      ...manifest,
      schedules: [
        {
          cron: "0 9 * * 1-5",
          hasRun: true,
          logicalPath: "schedules/daily-digest.ts",
          name: "daily-digest",
          sourceId: "schedules/daily-digest.ts",
          sourceKind: "module",
        },
      ],
    };

    const refs = collectModuleRefsForManifest(manifestWithSchedule);

    expect(refs).toContainEqual({
      sourceKind: "module",
      logicalPath: "schedules/daily-digest.ts",
      sourceId: "schedules/daily-digest.ts",
    });
  });

  it("omits markdown schedules from the module map", () => {
    const manifest = createManifestWithTool("/agent");
    const manifestWithSchedule: CompiledAgentManifest = {
      ...manifest,
      schedules: [
        {
          cron: "0 0 * * 0",
          hasRun: false,
          logicalPath: "schedules/cleanup.md",
          name: "cleanup",
          sourceId: "schedules/cleanup.md",
          sourceKind: "markdown",
          markdown: "Clean up stale data.",
        },
      ],
    };

    const refs = collectModuleRefsForManifest(manifestWithSchedule);

    expect(refs.some((ref) => ref.sourceId === "schedules/cleanup.md")).toBe(false);
  });

  it("omits module-sourced schedules that only carry markdown (no run handler)", () => {
    const manifest = createManifestWithTool("/agent");
    const manifestWithSchedule: CompiledAgentManifest = {
      ...manifest,
      schedules: [
        {
          cron: "0 8 * * *",
          hasRun: false,
          logicalPath: "schedules/daily-digest.mjs",
          name: "daily-digest",
          markdown: "Send a weather digest.",
          sourceId: "schedules/daily-digest.mjs",
          sourceKind: "module",
        },
      ],
    };

    const refs = collectModuleRefsForManifest(manifestWithSchedule);

    expect(refs.some((ref) => ref.sourceId === "schedules/daily-digest.mjs")).toBe(false);
  });

  it("keeps remote config modules in their independently owned node scope", () => {
    const manifest = createManifestWithTool("/agent");
    const remote = createTestCompiledRemoteAgentNode({
      backing: {
        externalDependencies: [],
        kind: "filesystem",
        sourcePath: "/agent/subagents/weather.ts",
      },
      configResolver: {
        logicalPath: "subagents/weather/agent.ts",
        sourceId: "subagents/weather::config",
        sourceKind: "module",
      },
      description: "Answer weather questions remotely.",
      entryPath: "/agent/subagents/weather.ts",
      logicalPath: "subagents/weather",
      name: "weather",
      nodeId: "subagents/weather",
      owner: { kind: "application" },
      path: "/eve/v1/session",
      rootPath: "/agent",
      sourceId: "subagents/weather",
      sourceKind: "subagent",
      url: "https://weather.example.com",
    });
    const manifestWithRemote: CompiledAgentManifest = {
      ...manifest,
      remoteAgents: [remote],
      sourceComposition: {
        ...manifest.sourceComposition,
        selected: [
          ...manifest.sourceComposition.selected,
          {
            slot: "subagents/weather",
            source: {
              backing: remote.backing,
              layer: "application",
              logicalPath: remote.logicalPath,
              owner: remote.owner,
              sourceId: remote.sourceId,
              sourceKind: "subagent",
            },
            sourceKind: "non-module",
          },
        ],
      },
    };
    const refs = collectModuleRefsForManifest(manifestWithRemote);
    const remoteScope = collectCompiledModuleScopes(manifestWithRemote).find(
      (scope) => scope.nodeId === remote.nodeId,
    );

    expect(refs).not.toContainEqual(remote.configResolver);
    expect(remoteScope?.refs).toEqual([
      {
        sourceKind: "module",
        logicalPath: "subagents/weather/agent.ts",
        sourceId: "subagents/weather::config",
      },
    ]);
  });
});
