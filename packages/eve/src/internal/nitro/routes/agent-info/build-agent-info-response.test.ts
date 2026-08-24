import { describe, expect, it } from "vitest";

import { AgentInfoResultSchema } from "#client/agent-info-schema.js";
import { createCompiledSubagentNodeId } from "#compiler/compiled-agent-node-id.js";
import { createCompiledChannelRoutePlan } from "#compiler/channel-route-plan.js";
import {
  createCompiledAgentManifest,
  ROOT_COMPILED_AGENT_NODE_ID,
  type CompiledChannelDefinition,
  type CompiledRemoteAgentNode,
  type CompiledSubagentNode,
} from "#compiler/manifest.js";
import { createModuleSourceDescriptor } from "#compiler/source-composition.js";
import { packageStateNamespace } from "#shared/extension-state-namespace.js";
import { buildAgentInfoResponse } from "#internal/nitro/routes/agent-info/build-agent-info-response.js";
import {
  createStubCompiledAgentManifest,
  createStubCompiledAgentNodeManifest,
  createTestCompiledAgentResources,
  createTestCompiledRemoteAgentNode,
  createTestCompiledModuleBindings,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
} from "#internal/testing/compiled-manifest.js";

const APP_ROOT = "/app";
const AGENT_ROOT = "/app/agent";
const CONFIG_SOURCE = {
  logicalPath: "agent.ts",
  sourceId: "opaque:config:winner",
  sourceKind: "module" as const,
};

const MODEL = {
  id: "openai/gpt-5.5",
  routing: { kind: "gateway" as const, target: "openai" },
};

const PROJECTION_INPUT = {
  gatewayCredentials: { apiKey: false, oidc: false },
  mode: "development" as const,
};

function programmaticBacking(moduleId: string, registryId = "agent-info-v3-test") {
  return {
    kind: "programmatic" as const,
    moduleId,
    registryId,
    revision: "v1",
  };
}

function extensionAuthority(owner: {
  readonly kind: "extension";
  readonly namespace: string;
  readonly packageName: string;
}) {
  const packageNamespace = packageStateNamespace(owner.packageName);
  const sourceRoot = `/packages/${packageNamespace}/agent`;
  const mountLogicalPath = `extensions/${owner.namespace}.ts`;
  const mountSourceId = `test:extension-mount:${owner.namespace}`;
  return {
    binding: {
      binding: {
        backing: {
          externalDependencies: [],
          kind: "filesystem" as const,
          sourcePath: `${AGENT_ROOT}/${mountLogicalPath}`,
        },
        owner: { kind: "application" as const },
      },
      logicalPath: mountLogicalPath,
      sourceId: mountSourceId,
    },
    mount: {
      externalDependencies: [],
      mountLogicalPath,
      mountSourceId,
      namespace: owner.namespace,
      packageName: owner.packageName,
      packageNamespace,
      sourceRoot,
    },
    sourceRoot,
  };
}

function extensionBinding(
  owner: { readonly kind: "extension"; readonly namespace: string; readonly packageName: string },
  logicalPath: string,
) {
  const authority = extensionAuthority(owner);
  return {
    backing: {
      externalDependencies: [],
      extensionScope: {
        namespace: authority.mount.packageNamespace,
        sourceRoot: authority.sourceRoot,
      },
      kind: "filesystem" as const,
      sourcePath: `${authority.sourceRoot}/${logicalPath}`,
    },
    owner,
  };
}

function project(manifest: ReturnType<typeof createStubCompiledAgentManifest>) {
  const response = buildAgentInfoResponse({ manifest }, PROJECTION_INPUT);
  expect(AgentInfoResultSchema.parse(response)).toEqual(response);
  return response;
}

function createBaseManifest(
  configOwner:
    | { readonly kind: "application" }
    | { readonly feature: string; readonly kind: "framework" } = { kind: "application" },
) {
  const binding =
    configOwner.kind === "framework"
      ? {
          backing: programmaticBacking(CONFIG_SOURCE.sourceId, configOwner.feature),
          owner: configOwner,
        }
      : { owner: configOwner };
  return createStubCompiledAgentManifest({
    agentRoot: AGENT_ROOT,
    appRoot: APP_ROOT,
    bindings: [
      {
        binding,
        logicalPath: CONFIG_SOURCE.logicalPath,
        sourceId: CONFIG_SOURCE.sourceId,
      },
    ],
    config: { model: MODEL, name: "Inspection test", source: CONFIG_SOURCE },
  });
}

describe("buildAgentInfoResponse", () => {
  it.each([
    ["authored", { kind: "application" } as const],
    ["default", { feature: "default-agent-config", kind: "framework" } as const],
  ])("projects opaque %s config identity from its required binding", (_, owner) => {
    const response = project(createBaseManifest(owner));

    expect(response.agent.configSource).toEqual({
      exportName: undefined,
      logicalPath: "agent.ts",
      owner,
      sourceId: "opaque:config:winner",
      sourceKind: "module",
    });
    expect(response.composition.selected.filter((entry) => entry.slot === "agent")).toEqual([
      {
        slot: "agent",
        source: response.agent.configSource,
        sourceKind: "module",
      },
    ]);
    expect(response.sandbox).toEqual(
      expect.objectContaining({
        hasBootstrap: false,
        hasOnSession: false,
        owner: { kind: "application" },
        sourceId: "test:stub-sandbox",
      }),
    );
  });

  it("preserves an agreed named export in selected composition", () => {
    const configSource = { ...CONFIG_SOURCE, exportName: "namedAgent" };
    const manifest = createStubCompiledAgentManifest({
      agentRoot: AGENT_ROOT,
      appRoot: APP_ROOT,
      bindings: [
        {
          logicalPath: configSource.logicalPath,
          sourceId: configSource.sourceId,
        },
      ],
      config: { model: MODEL, name: "Named config", source: configSource },
    });
    const response = project(manifest);

    expect(response.agent.configSource.exportName).toBe("namedAgent");
    expect(response.composition.selected.find((entry) => entry.slot === "agent")?.source).toEqual(
      response.agent.configSource,
    );
  });

  it("nests dynamic model routing with exact resolver events and provenance", () => {
    const owner = {
      kind: "extension" as const,
      namespace: "crm",
      packageName: "@acme/crm",
    };
    const authority = extensionAuthority(owner);
    const manifest = createStubCompiledAgentManifest({
      agentRoot: AGENT_ROOT,
      appRoot: APP_ROOT,
      bindings: [
        authority.binding,
        {
          binding: extensionBinding(owner, CONFIG_SOURCE.logicalPath),
          logicalPath: CONFIG_SOURCE.logicalPath,
          sourceId: CONFIG_SOURCE.sourceId,
        },
      ],
      config: {
        dynamicModel: {
          ...CONFIG_SOURCE,
          eventNames: ["session.started", "turn.started"],
        },
        name: "Dynamic model",
        source: CONFIG_SOURCE,
      },
      extensionMounts: [authority.mount],
    });

    expect(project(manifest).agent.model).toEqual({
      reasoning: undefined,
      routing: {
        kind: "dynamic",
        resolver: {
          eventNames: ["session.started", "turn.started"],
          exportName: undefined,
          logicalPath: "agent.ts",
          owner,
          sourceId: "opaque:config:winner",
          sourceKind: "module",
        },
      },
    });
  });

  it("projects every local and remote node with its exact parent scope", () => {
    const localSourceId = "opaque:local:source";
    const localNodeId = createCompiledSubagentNodeId(ROOT_COMPILED_AGENT_NODE_ID, localSourceId);
    const nestedLocalSourceId = "opaque:nested-local:source";
    const nestedLocalNodeId = createCompiledSubagentNodeId(localNodeId, nestedLocalSourceId);
    const nestedRemoteSourceId = "opaque:nested-remote:source";
    const nestedRemoteNodeId = createCompiledSubagentNodeId(
      nestedLocalNodeId,
      nestedRemoteSourceId,
    );
    const remoteSourceId = "opaque:remote:source";
    const remoteNodeId = createCompiledSubagentNodeId(ROOT_COMPILED_AGENT_NODE_ID, remoteSourceId);
    const extensionOwner = {
      kind: "extension" as const,
      namespace: "research",
      packageName: "@acme/research",
    };
    const extension = extensionAuthority(extensionOwner);
    const localResolver = {
      eventNames: ["session.started", "turn.started"],
      logicalPath: "agent.ts",
      sourceId: "opaque:local:config",
      sourceKind: "module" as const,
    };
    const nestedRemoteConfig = {
      logicalPath: "subagents/remote/agent.ts",
      sourceId: "opaque:nested-remote:config",
      sourceKind: "module" as const,
    };
    const nestedRemote = createTestCompiledRemoteAgentNode({
      backing: programmaticBacking(nestedRemoteSourceId),
      configResolver: nestedRemoteConfig,
      description: "Remote owned by a nested local",
      entryPath: `${AGENT_ROOT}/subagents/research/subagents/research/subagents/remote`,
      logicalPath: "subagents/remote",
      name: "remote",
      nodeId: nestedRemoteNodeId,
      owner: { kind: "application" as const },
      path: "/sessions",
      rootPath: `${AGENT_ROOT}/subagents/research/subagents/research/subagents/remote`,
      sourceId: nestedRemoteSourceId,
      sourceKind: "subagent" as const,
      url: "https://nested-remote.example",
    } satisfies Omit<CompiledRemoteAgentNode, "bindings" | "sourceComposition">);
    const nestedLocal = {
      agent: createStubCompiledAgentNodeManifest(
        {
          agentRoot: `${AGENT_ROOT}/subagents/research/subagents/research`,
          appRoot: APP_ROOT,
          bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
          config: {
            description: "Nested local specialist",
            model: MODEL,
            name: "Nested research",
            source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
          },
          remoteAgents: [nestedRemote],
        },
        { isRoot: false, nodeId: nestedLocalNodeId },
      ),
      backing: {
        externalDependencies: [],
        kind: "filesystem" as const,
        sourcePath: `${AGENT_ROOT}/subagents/research/subagents/research/agent.ts`,
      },
      description: "Nested local specialist",
      entryPath: `${AGENT_ROOT}/subagents/research/subagents/research/agent.ts`,
      logicalPath: "subagents/research",
      name: "research",
      nodeId: nestedLocalNodeId,
      owner: { kind: "application" as const },
      rootPath: `${AGENT_ROOT}/subagents/research/subagents/research`,
      sourceId: nestedLocalSourceId,
      sourceKind: "subagent" as const,
    } satisfies CompiledSubagentNode;
    const localResources = createTestCompiledAgentResources(
      {
        agentRoot: `${AGENT_ROOT}/subagents/research`,
        appRoot: APP_ROOT,
        bindings: [
          {
            binding: extensionBinding(extensionOwner, "subagents/research/agent.ts"),
            logicalPath: localResolver.logicalPath,
            sourceId: localResolver.sourceId,
          },
        ],
        subagentSources: [nestedLocal],
      },
      { additionalBindingReferences: [localResolver], isRoot: false, nodeId: localNodeId },
    );
    const local = {
      agent: localResources,
      backing: extensionBinding(extensionOwner, "subagents/research/agent.ts").backing,
      configResolver: localResolver,
      entryPath: `${extension.sourceRoot}/subagents/research/agent.ts`,
      logicalPath: "subagents/research",
      name: "research",
      nodeId: localNodeId,
      owner: extensionOwner,
      rootPath: `${extension.sourceRoot}/subagents/research`,
      sourceId: localSourceId,
      sourceKind: "subagent" as const,
    } satisfies CompiledSubagentNode;
    const remoteConfig = {
      logicalPath: "subagents/remote/agent.ts",
      sourceId: "opaque:remote:config",
      sourceKind: "module" as const,
    };
    const remote = createTestCompiledRemoteAgentNode({
      backing: programmaticBacking(remoteSourceId),
      configResolver: remoteConfig,
      description: "Remote specialist",
      entryPath: `${AGENT_ROOT}/subagents/remote`,
      logicalPath: "subagents/remote",
      name: "remote",
      nodeId: remoteNodeId,
      owner: { kind: "application" as const },
      path: "/sessions",
      rootPath: `${AGENT_ROOT}/subagents/remote`,
      sourceId: remoteSourceId,
      sourceKind: "subagent" as const,
      url: "https://remote.example",
    } satisfies Omit<CompiledRemoteAgentNode, "bindings" | "sourceComposition">);
    const manifest = createStubCompiledAgentManifest({
      agentRoot: AGENT_ROOT,
      appRoot: APP_ROOT,
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING, extension.binding],
      config: { model: MODEL, name: "Agent graph", source: TEST_COMPILED_AGENT_CONFIG_SOURCE },
      extensionMounts: [extension.mount],
      remoteAgents: [remote],
      subagentEdges: [
        { childNodeId: local.nodeId, parentNodeId: ROOT_COMPILED_AGENT_NODE_ID },
        { childNodeId: nestedLocal.nodeId, parentNodeId: local.nodeId },
      ],
      subagents: [local, nestedLocal],
    });
    const response = project(manifest);

    expect(response.agent.nodeId).toBe(ROOT_COMPILED_AGENT_NODE_ID);
    expect(response.subagents.total).toBe(2);
    expect(
      response.subagents.local.map(({ nodeId, parentNodeId, sourceId }) => ({
        nodeId,
        parentNodeId,
        sourceId,
      })),
    ).toEqual([
      {
        nodeId: localNodeId,
        parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
        sourceId: localSourceId,
      },
      {
        nodeId: nestedLocalNodeId,
        parentNodeId: localNodeId,
        sourceId: nestedLocalSourceId,
      },
    ]);
    expect(response.subagents.local[0]).toEqual(
      expect.objectContaining({
        configResolver: {
          eventNames: ["session.started", "turn.started"],
          exportName: undefined,
          logicalPath: "agent.ts",
          owner: extensionOwner,
          sourceId: "opaque:local:config",
          sourceKind: "module",
        },
        owner: extensionOwner,
      }),
    );
    expect(response.remoteAgents).toEqual({
      entries: [
        expect.objectContaining({
          configResolver: {
            exportName: undefined,
            logicalPath: "subagents/remote/agent.ts",
            owner: { kind: "application" },
            sourceId: "opaque:remote:config",
            sourceKind: "module",
          },
          owner: { kind: "application" },
          parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
          sourceId: remoteSourceId,
        }),
        expect.objectContaining({
          configResolver: {
            exportName: undefined,
            logicalPath: "subagents/remote/agent.ts",
            owner: { kind: "application" },
            sourceId: "opaque:nested-remote:config",
            sourceKind: "module",
          },
          nodeId: nestedRemoteNodeId,
          owner: { kind: "application" },
          parentNodeId: nestedLocalNodeId,
          sourceId: nestedRemoteSourceId,
        }),
      ],
      total: 2,
    });
    expect(
      response.composition.selected
        .filter((entry) => entry.source.sourceKind === "subagent")
        .map((entry) => ({
          owner: entry.source.owner,
          sourceId: entry.source.sourceId,
        })),
    ).toEqual([
      {
        owner: extensionOwner,
        sourceId: localSourceId,
      },
      {
        owner: { kind: "application" },
        sourceId: remoteSourceId,
      },
    ]);
    expect(
      new Set([
        ...response.subagents.local.map((entry) => entry.nodeId),
        ...response.remoteAgents.entries.map((entry) => entry.nodeId),
      ]).size,
    ).toBe(4);
  });

  it("includes dynamic resources in local subagent summaries", () => {
    const sourceId = "opaque:dynamic-summary:source";
    const nodeId = createCompiledSubagentNodeId(ROOT_COMPILED_AGENT_NODE_ID, sourceId);
    const configResolver = {
      eventNames: ["session.started"],
      logicalPath: "agent.ts",
      sourceId: "opaque:dynamic-summary:config",
      sourceKind: "module" as const,
    };
    const dynamicSources = [
      { logicalPath: "instructions/context.ts", sourceId: "opaque:dynamic:instructions" },
      { logicalPath: "skills/context.ts", sourceId: "opaque:dynamic:skill" },
      { logicalPath: "tools/context.ts", sourceId: "opaque:dynamic:tool" },
    ] as const;
    const resources = createTestCompiledAgentResources(
      {
        agentRoot: `${AGENT_ROOT}/subagents/dynamic-summary`,
        appRoot: APP_ROOT,
        bindings: [
          { logicalPath: configResolver.logicalPath, sourceId: configResolver.sourceId },
          ...dynamicSources,
        ],
        dynamicInstructions: [
          {
            eventNames: ["session.started"],
            ...dynamicSources[0],
            slug: "context",
            sourceKind: "module",
          },
        ],
        dynamicSkills: [
          {
            eventNames: ["turn.started"],
            ...dynamicSources[1],
            slug: "context",
            sourceKind: "module",
          },
        ],
        dynamicTools: [
          {
            eventNames: ["step.started"],
            ...dynamicSources[2],
            slug: "context",
            sourceKind: "module",
          },
        ],
      },
      { additionalBindingReferences: [configResolver], isRoot: false, nodeId },
    );
    const entryPath = `${AGENT_ROOT}/subagents/dynamic-summary/agent.ts`;
    const subagent = {
      agent: resources,
      backing: { externalDependencies: [], kind: "filesystem" as const, sourcePath: entryPath },
      configResolver,
      entryPath,
      logicalPath: "subagents/dynamic-summary",
      name: "dynamic-summary",
      nodeId,
      owner: { kind: "application" as const },
      rootPath: `${AGENT_ROOT}/subagents/dynamic-summary`,
      sourceId,
      sourceKind: "subagent" as const,
    } satisfies CompiledSubagentNode;
    const manifest = createStubCompiledAgentManifest({
      agentRoot: AGENT_ROOT,
      appRoot: APP_ROOT,
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        model: MODEL,
        name: "Dynamic summary",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      subagentEdges: [{ childNodeId: nodeId, parentNodeId: ROOT_COMPILED_AGENT_NODE_ID }],
      subagents: [subagent],
    });

    expect(project(manifest).subagents.local[0]?.summary).toEqual({
      channels: 0,
      connections: 0,
      hooks: 0,
      instructions: true,
      schedules: 0,
      skills: 1,
      tools: 1,
    });
  });

  it("projects exactly the effective and retained shadowed channel route plan", () => {
    const loserOwner = {
      kind: "extension" as const,
      namespace: "crm",
      packageName: "@acme/crm",
    };
    const extension = extensionAuthority(loserOwner);
    const winner = {
      exportName: "primaryChannel",
      kind: "channel",
      logicalPath: "channels/primary.ts",
      method: "GET",
      name: "primary",
      sourceId: "opaque:channel:winner",
      sourceKind: "module",
      urlPath: "/users/:id",
    } satisfies CompiledChannelDefinition;
    const loser = {
      exportName: "secondaryChannel",
      kind: "channel",
      logicalPath: "channels/secondary.ts",
      method: "GET",
      name: "secondary",
      sourceId: "opaque:channel:loser",
      sourceKind: "module",
      urlPath: "/users/:name",
    } satisfies CompiledChannelDefinition;
    const bindingInputs = [
      extension.binding,
      { logicalPath: winner.logicalPath, sourceId: winner.sourceId },
      {
        binding: extensionBinding(loserOwner, loser.logicalPath),
        logicalPath: loser.logicalPath,
        sourceId: loser.sourceId,
      },
    ];
    const diagnostics: Parameters<typeof createCompiledChannelRoutePlan>[0]["diagnostics"] = [];
    const channelRoutes = createCompiledChannelRoutePlan({
      bindings: createTestCompiledModuleBindings(bindingInputs),
      diagnostics,
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
      routes: [winner, loser],
    });
    const manifest = createStubCompiledAgentManifest({
      agentRoot: AGENT_ROOT,
      appRoot: APP_ROOT,
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING, ...bindingInputs],
      channelRoutes,
      config: { model: MODEL, name: "Routes", source: TEST_COMPILED_AGENT_CONFIG_SOURCE },
      diagnosticsSummary: { errors: 0, warnings: diagnostics.length },
      extensionMounts: [extension.mount],
    });
    const response = project(manifest);

    expect(
      response.channels.map(({ method, name, sourceId, urlPath }) => ({
        method,
        name,
        sourceId,
        urlPath,
      })),
    ).toEqual([
      {
        method: "GET",
        name: "primary",
        sourceId: "opaque:channel:winner",
        urlPath: "/users/:id",
      },
    ]);
    expect(response.composition.routes.shadowed).toEqual([
      {
        loser: {
          adapterKind: undefined,
          exportName: "secondaryChannel",
          logicalPath: "channels/secondary.ts",
          method: "GET",
          name: "secondary",
          owner: {
            kind: "extension",
            namespace: "crm",
            packageName: "@acme/crm",
          },
          sourceId: "opaque:channel:loser",
          sourceKind: "module",
          urlPath: "/users/:name",
        },
        method: channelRoutes.shadowed[0]!.method,
        pathPattern: channelRoutes.shadowed[0]!.pathPattern,
        winningSourceId: channelRoutes.shadowed[0]!.winningSourceId,
      },
    ]);
    expect(response.diagnostics).toEqual({ errors: 0, warnings: 1 });
  });

  it("projects retained disabled and shadowed source composition without reconstruction", () => {
    const base = createBaseManifest();
    const disabledSource = createModuleSourceDescriptor({
      backing: programmaticBacking("opaque:disabled"),
      layer: "application",
      logicalPath: "tools/disabled.ts",
      owner: { kind: "application" },
      sourceId: "opaque:disabled",
    });
    const shadowedConfig = createModuleSourceDescriptor({
      backing: programmaticBacking("opaque:default-config", "default-agent-config"),
      layer: "framework-default",
      logicalPath: "agent.ts",
      owner: { feature: "default-agent-config", kind: "framework" },
      sourceId: "opaque:default-config",
    });
    const manifest = createCompiledAgentManifest({
      ...base,
      sourceComposition: {
        disabled: [{ slot: "tools/disabled", source: disabledSource }],
        selected: base.sourceComposition.selected,
        shadowed: [
          {
            slot: "agent",
            source: shadowedConfig,
            winningSourceId: CONFIG_SOURCE.sourceId,
          },
        ],
      },
    });
    const response = project(manifest);

    expect(response.composition.disabled).toEqual([
      {
        slot: "tools/disabled",
        source: {
          exportName: undefined,
          layer: "application",
          logicalPath: "tools/disabled.ts",
          owner: { kind: "application" },
          sourceId: "opaque:disabled",
          sourceKind: "module",
        },
      },
    ]);
    expect(response.composition.shadowed).toEqual([
      {
        slot: "agent",
        source: {
          exportName: undefined,
          layer: "framework-default",
          logicalPath: "agent.ts",
          owner: { feature: "default-agent-config", kind: "framework" },
          sourceId: "opaque:default-config",
          sourceKind: "module",
        },
        winningSourceId: "opaque:config:winner",
      },
    ]);
  });

  it("uses normalized metadata and the prepared kernel inspection projection exactly once", () => {
    const extensionOwner = {
      kind: "extension" as const,
      namespace: "crm",
      packageName: "@acme/crm",
    };
    const extension = extensionAuthority(extensionOwner);
    const frameworkTool = {
      description: "Load one compiled skill.",
      hasAuth: false,
      hasExecute: true,
      hasModelOutputProjection: false,
      inputSchema: null,
      logicalPath: "tools/load_skill.ts",
      name: "load_skill",
      requiresApproval: false,
      sourceId: "opaque:framework:load-skill",
      sourceKind: "module" as const,
    };
    const authoredTool = {
      description: "Search CRM records.",
      hasAuth: true,
      hasExecute: false,
      hasModelOutputProjection: true,
      inputSchema: { type: "object" },
      logicalPath: "tools/crm__search.ts",
      name: "crm__search",
      outputSchema: { type: "object" },
      requiresApproval: true,
      sourceId: "opaque:extension:tool",
      sourceKind: "module" as const,
    };
    const manifest = createStubCompiledAgentManifest({
      agentRoot: AGENT_ROOT,
      appRoot: APP_ROOT,
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        extension.binding,
        {
          binding: {
            backing: programmaticBacking(frameworkTool.sourceId, "load-skill"),
            owner: { feature: "load-skill", kind: "framework" },
          },
          logicalPath: frameworkTool.logicalPath,
          sourceId: frameworkTool.sourceId,
        },
        {
          binding: extensionBinding(extensionOwner, authoredTool.logicalPath),
          logicalPath: authoredTool.logicalPath,
          sourceId: authoredTool.sourceId,
        },
        {
          binding: extensionBinding(extensionOwner, "connections/crm.ts"),
          logicalPath: "connections/crm.ts",
          sourceId: "opaque:connection",
        },
        {
          binding: extensionBinding(extensionOwner, "hooks/audit.ts"),
          logicalPath: "hooks/audit.ts",
          sourceId: "opaque:hook",
        },
        {
          logicalPath: "sandbox.ts",
          sourceId: "opaque:sandbox",
        },
      ],
      config: { model: MODEL, name: "Capabilities", source: TEST_COMPILED_AGENT_CONFIG_SOURCE },
      extensionMounts: [extension.mount],
      connections: [
        {
          connectionName: "crm",
          description: "CRM MCP",
          hasApproval: true,
          hasAuthorization: true,
          hasHeaders: false,
          logicalPath: "connections/crm.ts",
          protocol: "mcp",
          sourceId: "opaque:connection",
          sourceKind: "module",
          url: "https://crm.example/mcp",
        },
      ],
      hooks: [
        {
          eventNames: ["session.started", "turn.started"],
          logicalPath: "hooks/audit.ts",
          slug: "audit",
          sourceId: "opaque:hook",
          sourceKind: "module",
        },
      ],
      sandbox: {
        hasBootstrap: true,
        hasOnSession: true,
        logicalPath: "sandbox.ts",
        sourceHash: "authored-sandbox",
        sourceId: "opaque:sandbox",
        sourceKind: "module",
      },
      skills: [
        {
          description: "CRM operations",
          logicalPath: "skills/crm/SKILL.md",
          markdown: "# CRM",
          name: "crm",
          sourceId: "opaque:skill",
          sourceKind: "markdown",
        },
      ],
      tools: [frameworkTool, authoredTool],
    });
    const response = project(manifest);

    expect(response.kernel.availability).toBe("prepared-potential");
    expect(response.kernel.frameworkSources.map((entry) => entry.name)).toEqual(["load_skill"]);
    expect(response.tools.static).toEqual([
      expect.objectContaining({
        hasAuth: true,
        hasExecute: false,
        hasModelOutputProjection: true,
        hasOutputSchema: true,
        name: "crm__search",
        owner: extensionOwner,
        requiresApproval: true,
      }),
    ]);
    expect(response.connections).toEqual([
      expect.objectContaining({
        hasApproval: true,
        hasAuthorization: true,
        hasHeaders: false,
      }),
    ]);
    expect(response.hooks[0]?.eventNames).toEqual(["session.started", "turn.started"]);
    expect(response.sandbox).toEqual(
      expect.objectContaining({ hasBootstrap: true, hasOnSession: true }),
    );

    const publicCapabilityNames = [
      ...response.kernel.frameworkSources.map((entry) => entry.name),
      ...response.kernel.native.map((entry) => entry.name),
      ...response.tools.static.map((entry) => entry.name),
    ];
    expect(new Set(publicCapabilityNames).size).toBe(publicCapabilityNames.length);
    expect(new Set(response.kernel.native.map((entry) => entry.name))).toEqual(
      new Set(manifest.kernelPlan.prepared.filter((name) => name !== "load_skill")),
    );
  });
});
