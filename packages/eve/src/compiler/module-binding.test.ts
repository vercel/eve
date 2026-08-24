import { describe, expect, it } from "vitest";

import {
  createCompiledAgentManifest as createCompiledAgentManifestBase,
  createCompiledAgentNodeManifest as createCompiledAgentNodeManifestBase,
  createCompiledAgentResources as createCompiledAgentResourcesBase,
  compiledAgentManifestSchema,
  type CompiledChannelRoutePlan,
  type CompiledSandboxDefinition,
  type CreateCompiledAgentManifestInput,
  type CreateCompiledAgentNodeManifestInput,
  type CreateCompiledAgentResourcesInput,
  type CreateCompiledAgentResourcesOptions,
} from "#compiler/manifest.js";
import { parseCompiledAgentManifest } from "#compiler/compiled-manifest-validation.js";
import type { CompiledModuleBinding } from "#compiler/module-binding.js";
import type { AgentSourceComposition } from "#compiler/source-composition.js";
import { assertCompiledExtensionMountSemantics } from "#compiler/compiled-agent-graph-semantics.js";
import { assertDynamicSubagentConfigResolverSemantics } from "#compiler/compiled-resource-semantics.js";
import { FRAMEWORK_AGENT_SOURCE_ID } from "#framework-sources/constants.js";
import {
  createStubCompiledAgentManifest,
  createTestCompiledRemoteAgentNode,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
} from "#internal/testing/compiled-manifest.js";

const EXTENSION_SOURCE_ID = "opaque-extension-source";
const EXTENSION_LOGICAL_PATH = "tools/crm__search.ts";
const CRM_EXTENSION_MOUNT: NonNullable<
  CreateCompiledAgentResourcesInput["extensionMounts"]
>[number] = {
  externalDependencies: ["extension-runtime"],
  mountLogicalPath: "extensions/crm.ts",
  mountSourceId: "extensions/crm.ts",
  namespace: "crm",
  packageName: "@acme/crm",
  packageNamespace: "acme-crm",
  sourceRoot: "/packages/crm/extension",
};
const TEST_SANDBOX_SOURCE_ID = "test:module-binding-sandbox";
const TEST_SANDBOX: CompiledSandboxDefinition = {
  hasBootstrap: false,
  hasOnSession: false,
  logicalPath: "sandbox.ts",
  sourceHash: "0".repeat(64),
  sourceId: TEST_SANDBOX_SOURCE_ID,
  sourceKind: "module",
};
const EMPTY_CHANNEL_ROUTES: CompiledChannelRoutePlan = {
  effective: [],
  preflight: [],
  shadowed: [],
};

type TestResourcesInput = Omit<
  CreateCompiledAgentResourcesInput,
  "channelRoutes" | "instrumentation" | "kernelPlan" | "sandbox"
> & {
  readonly channelRoutes?: CompiledChannelRoutePlan;
  readonly instrumentation?: CreateCompiledAgentResourcesInput["instrumentation"];
  readonly kernelPlan?: CreateCompiledAgentResourcesInput["kernelPlan"];
  readonly sandbox?: CompiledSandboxDefinition;
};
type TestNodeInput = Omit<
  CreateCompiledAgentNodeManifestInput,
  "channelRoutes" | "instrumentation" | "kernelPlan" | "sandbox"
> & {
  readonly channelRoutes?: CompiledChannelRoutePlan;
  readonly instrumentation?: CreateCompiledAgentResourcesInput["instrumentation"];
  readonly kernelPlan?: CreateCompiledAgentResourcesInput["kernelPlan"];
  readonly sandbox?: CompiledSandboxDefinition;
};
type TestManifestInput = Omit<
  CreateCompiledAgentManifestInput,
  | "channelRoutes"
  | "externalDependencyPlan"
  | "instrumentation"
  | "kernelPlan"
  | "sandbox"
  | "workflowWorld"
> & {
  readonly channelRoutes?: CompiledChannelRoutePlan;
  readonly externalDependencyPlan?: CreateCompiledAgentManifestInput["externalDependencyPlan"];
  readonly instrumentation?: CreateCompiledAgentResourcesInput["instrumentation"];
  readonly kernelPlan?: CreateCompiledAgentResourcesInput["kernelPlan"];
  readonly sandbox?: CompiledSandboxDefinition;
  readonly workflowWorld?: CreateCompiledAgentManifestInput["workflowWorld"];
};

function createCompiledAgentResources(
  input: TestResourcesInput,
  options: Partial<CreateCompiledAgentResourcesOptions> = {},
) {
  return createCompiledAgentResourcesBase(
    withTestSandbox(input, ["ask_question", "final_output"]),
    { isRoot: false, nodeId: "test-resources", ...options },
  );
}

function createCompiledAgentNodeManifest(
  input: TestNodeInput,
  options: Partial<
    Pick<CreateCompiledAgentResourcesOptions, "isRoot" | "nodeId" | "subagentSources">
  > = {},
) {
  return createCompiledAgentNodeManifestBase(
    withTestSandbox(input, ["ask_question", "final_output"]),
    { isRoot: false, nodeId: "test-node", ...options },
  );
}

function createCompiledAgentManifest(input: TestManifestInput) {
  return createCompiledAgentManifestBase({
    ...withTestSandbox(input, ["agent", "ask_question", "final_output"]),
    externalDependencyPlan: input.externalDependencyPlan ?? { entries: [] },
    workflowWorld: input.workflowWorld ?? {
      kind: "native",
      selection: "host-default",
      target: "local",
    },
  });
}

function withTestSandbox<
  T extends {
    readonly bindings: Readonly<Record<string, CompiledModuleBinding>>;
    readonly channelRoutes?: CompiledChannelRoutePlan;
    readonly instrumentation?: CreateCompiledAgentResourcesInput["instrumentation"];
    readonly kernelPlan?: CreateCompiledAgentResourcesInput["kernelPlan"];
    readonly sandbox?: CompiledSandboxDefinition;
    readonly sourceComposition: AgentSourceComposition;
  },
>(
  input: T,
  defaultPrepared: CreateCompiledAgentResourcesInput["kernelPlan"]["prepared"],
): T & {
  readonly bindings: Readonly<Record<string, CompiledModuleBinding>>;
  readonly channelRoutes: CompiledChannelRoutePlan;
  readonly instrumentation: CreateCompiledAgentResourcesInput["instrumentation"];
  readonly kernelPlan: CreateCompiledAgentResourcesInput["kernelPlan"];
  readonly sandbox: CompiledSandboxDefinition;
  readonly sourceComposition: AgentSourceComposition;
} {
  if (input.sandbox !== undefined) {
    return {
      ...input,
      channelRoutes: input.channelRoutes ?? EMPTY_CHANNEL_ROUTES,
      instrumentation: input.instrumentation ?? { kind: "none" },
      kernelPlan: input.kernelPlan ?? { prepared: defaultPrepared },
    } as T & {
      readonly channelRoutes: CompiledChannelRoutePlan;
      readonly instrumentation: CreateCompiledAgentResourcesInput["instrumentation"];
      readonly kernelPlan: CreateCompiledAgentResourcesInput["kernelPlan"];
      readonly sandbox: CompiledSandboxDefinition;
    };
  }
  return {
    ...input,
    bindings: {
      ...input.bindings,
      [TEST_SANDBOX_SOURCE_ID]: {
        backing: {
          kind: "programmatic",
          moduleId: "sandbox.ts",
          registryId: "test-module-binding",
          revision: "test-revision",
        },
        logicalPath: TEST_SANDBOX.logicalPath,
        owner: { kind: "application" },
      },
    },
    channelRoutes: input.channelRoutes ?? EMPTY_CHANNEL_ROUTES,
    instrumentation: input.instrumentation ?? { kind: "none" },
    kernelPlan: input.kernelPlan ?? { prepared: defaultPrepared },
    sandbox: TEST_SANDBOX,
    sourceComposition: {
      ...input.sourceComposition,
      selected: [
        ...input.sourceComposition.selected,
        { slot: "sandbox", sourceId: TEST_SANDBOX_SOURCE_ID, sourceKind: "module" },
      ],
    },
  };
}

function createExtensionBinding(
  overrides: Partial<CompiledModuleBinding> = {},
): CompiledModuleBinding {
  return {
    backing: {
      externalDependencies: ["app-runtime", "extension-runtime"],
      extensionScope: {
        namespace: "acme-crm",
        sourceRoot: "/packages/crm/extension",
      },
      kind: "filesystem",
      sourcePath: "/packages/crm/extension/tools/search.ts",
    },
    logicalPath: EXTENSION_LOGICAL_PATH,
    owner: {
      kind: "extension",
      namespace: "crm",
      packageName: "@acme/crm",
    },
    ...overrides,
  };
}

function createResources(
  bindings: Readonly<Record<string, CompiledModuleBinding>>,
  extensionMounts: NonNullable<CreateCompiledAgentResourcesInput["extensionMounts"]> = [
    CRM_EXTENSION_MOUNT,
  ],
) {
  return createCompiledAgentResources({
    agentRoot: "/app/agent",
    appRoot: "/app",
    bindings: {
      "extensions/crm.ts": {
        backing: {
          externalDependencies: [],
          kind: "filesystem",
          sourcePath: "/app/agent/extensions/crm.ts",
        },
        logicalPath: "extensions/crm.ts",
        owner: { kind: "application" },
      },
      ...bindings,
    },
    sourceComposition: {
      disabled: [],
      selected: [
        { slot: "extensions/crm", sourceId: "extensions/crm.ts", sourceKind: "module" },
        { slot: "tools/crm__search", sourceId: EXTENSION_SOURCE_ID, sourceKind: "module" },
      ],
      shadowed: [],
    },
    extensionMounts,
    tools: [
      {
        description: "Searches CRM records.",
        hasAuth: false,
        hasExecute: true,
        hasModelOutputProjection: false,
        inputSchema: null,
        logicalPath: EXTENSION_LOGICAL_PATH,
        name: "crm__search",
        sourceId: EXTENSION_SOURCE_ID,
        sourceKind: "module",
        requiresApproval: false,
      },
    ],
  });
}

describe("compiled module bindings", () => {
  it("keeps canonical logical identity separate from physical extension backing", () => {
    const resources = createResources({
      [EXTENSION_SOURCE_ID]: createExtensionBinding(),
    });

    expect(resources.bindings[EXTENSION_SOURCE_ID]).toEqual({
      backing: {
        externalDependencies: ["app-runtime", "extension-runtime"],
        extensionScope: {
          namespace: "acme-crm",
          sourceRoot: "/packages/crm/extension",
        },
        kind: "filesystem",
        sourcePath: "/packages/crm/extension/tools/search.ts",
      },
      logicalPath: "tools/crm__search.ts",
      owner: {
        kind: "extension",
        namespace: "crm",
        packageName: "@acme/crm",
      },
    });
  });

  it.each([
    { eventNames: ["message.delta"], expected: 'unsupported event "message.delta"' },
    {
      eventNames: ["turn.started", "turn.started"],
      expected: 'event "turn.started" more than once',
    },
  ])("rejects invalid serialized dynamic tool events", ({ eventNames, expected }) => {
    expect(() =>
      createCompiledAgentResources({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: {
          dynamic: {
            backing: {
              kind: "programmatic",
              moduleId: "tools/dynamic.ts",
              registryId: "test",
              revision: "test-v1",
            },
            logicalPath: "tools/dynamic.ts",
            owner: { kind: "application" },
          },
        },
        dynamicTools: [
          {
            eventNames,
            logicalPath: "tools/dynamic.ts",
            slug: "dynamic",
            sourceId: "dynamic",
            sourceKind: "module",
          },
        ],
        sourceComposition: {
          disabled: [],
          selected: [{ slot: "tools/dynamic", sourceId: "dynamic", sourceKind: "module" }],
          shadowed: [],
        },
      }),
    ).toThrow(expected);
  });

  it("rejects invalid serialized dynamic subagent events", () => {
    expect(() =>
      assertDynamicSubagentConfigResolverSemantics({
        nodeId: "researcher",
        resolver: {
          eventNames: ["step.started"],
          logicalPath: "agent.ts",
          sourceId: "dynamic-config",
          sourceKind: "module",
        },
        resources: createCompiledAgentResources(
          {
            agentRoot: "/app/agent/subagents/researcher",
            appRoot: "/app",
            bindings: {
              "dynamic-config": {
                backing: {
                  kind: "programmatic",
                  moduleId: "agent.ts",
                  registryId: "test",
                  revision: "test-v1",
                },
                logicalPath: "agent.ts",
                owner: { kind: "application" },
              },
            },
            sourceComposition: {
              disabled: [],
              selected: [{ slot: "agent", sourceId: "dynamic-config", sourceKind: "module" }],
              shadowed: [],
            },
          },
          {
            additionalBindingReferences: [
              {
                logicalPath: "agent.ts",
                sourceId: "dynamic-config",
                sourceKind: "module",
              },
            ],
            nodeId: "researcher",
          },
        ),
        subagentLogicalPath: "subagents/researcher",
      }),
    ).toThrow('unsupported event "step.started"');
  });

  it("rejects non-canonical extension mount logical paths", () => {
    const resources = createResources({ [EXTENSION_SOURCE_ID]: createExtensionBinding() });
    expect(() =>
      assertCompiledExtensionMountSemantics(
        {
          ...resources,
          extensionMounts: [{ ...CRM_EXTENSION_MOUNT, mountLogicalPath: "extensions/crm.evil.ts" }],
        },
        "__root__",
      ),
    ).toThrow('extension mount "crm" does not match logical path "extensions/crm.evil.ts"');
  });

  it("rejects duplicate extension mount namespaces", () => {
    expect(() =>
      createResources({ [EXTENSION_SOURCE_ID]: createExtensionBinding() }, [
        CRM_EXTENSION_MOUNT,
        { ...CRM_EXTENSION_MOUNT, packageName: "@acme/other" },
      ]),
    ).toThrow('repeats extension mount namespace "crm"');
  });

  it("rejects duplicate extension mount source identities", () => {
    expect(() =>
      createResources({ [EXTENSION_SOURCE_ID]: createExtensionBinding() }, [
        CRM_EXTENSION_MOUNT,
        { ...CRM_EXTENSION_MOUNT, namespace: "other" },
      ]),
    ).toThrow('repeats extension mount source "extensions/crm.ts"');
  });

  it("rejects missing bindings at construction", () => {
    expect(() => createResources({})).toThrow(`missing a binding for "${EXTENSION_SOURCE_ID}"`);
  });

  it("rejects unreferenced bindings at construction", () => {
    expect(() =>
      createResources({
        [EXTENSION_SOURCE_ID]: createExtensionBinding(),
        extra: {
          backing: {
            externalDependencies: [],
            kind: "filesystem",
            sourcePath: "/app/agent/tools/extra.ts",
          },
          logicalPath: "tools/extra.ts",
          owner: { kind: "application" },
        },
      }),
    ).toThrow('unreferenced binding for "extra"');
  });

  it("rejects binding and reference path mismatches at construction", () => {
    expect(() =>
      createResources({
        [EXTENSION_SOURCE_ID]: createExtensionBinding({ logicalPath: "tools/crm/other.ts" }),
      }),
    ).toThrow(`selects "${EXTENSION_SOURCE_ID}" for slot "tools/crm__search"`);
  });

  it("rejects one source id used for conflicting logical paths", () => {
    expect(() =>
      createCompiledAgentResources({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: {
          duplicate: {
            backing: {
              externalDependencies: [],
              kind: "filesystem",
              sourcePath: "/app/agent/tools/one.ts",
            },
            logicalPath: "tools/one.ts",
            owner: { kind: "application" },
          },
        },
        sourceComposition: {
          disabled: [],
          selected: [{ slot: "tools/one", sourceId: "duplicate", sourceKind: "module" }],
          shadowed: [],
        },
        tools: [
          {
            description: "One.",
            hasAuth: false,
            hasExecute: true,
            hasModelOutputProjection: false,
            inputSchema: null,
            logicalPath: "tools/one.ts",
            name: "one",
            sourceId: "duplicate",
            sourceKind: "module",
            requiresApproval: false,
          },
          {
            description: "Two.",
            hasAuth: false,
            hasExecute: true,
            hasModelOutputProjection: false,
            inputSchema: null,
            logicalPath: "tools/two.ts",
            name: "two",
            sourceId: "duplicate",
            sourceKind: "module",
            requiresApproval: false,
          },
        ],
      }),
    ).toThrow(
      'references source id "duplicate" with conflicting module projections "tools/one.ts#default" and "tools/two.ts#default"',
    );
  });

  it("rejects one source id used for conflicting named exports", () => {
    const tool = {
      description: "Reads data.",
      exportName: "read",
      hasAuth: false,
      hasExecute: true,
      hasModelOutputProjection: false,
      inputSchema: null,
      logicalPath: "tools/read.ts",
      name: "read",
      requiresApproval: false,
      sourceId: "read-tool",
      sourceKind: "module" as const,
    };
    expect(() =>
      createCompiledAgentResources({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: {
          "read-tool": {
            backing: {
              kind: "programmatic",
              moduleId: "tools/read.ts",
              registryId: "test",
              revision: "test-v1",
            },
            logicalPath: tool.logicalPath,
            owner: { kind: "application" },
          },
        },
        sourceComposition: {
          disabled: [],
          selected: [{ slot: "tools/read", sourceId: tool.sourceId, sourceKind: "module" }],
          shadowed: [],
        },
        tools: [tool, { ...tool, exportName: "readAlternate" }],
      }),
    ).toThrow(/tools\/read\.ts#read.*tools\/read\.ts#readAlternate/u);
  });

  it("rejects a selected source reinterpreted as a different primitive family", () => {
    expect(() =>
      createCompiledAgentResources({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: {
          "read-tool": {
            backing: {
              kind: "programmatic",
              moduleId: "tools/read.ts",
              registryId: "test",
              revision: "test-v1",
            },
            logicalPath: "tools/read.ts",
            owner: { kind: "application" },
          },
        },
        connections: [
          {
            connectionName: "read",
            description: "Forged connection.",
            hasApproval: false,
            hasAuthorization: false,
            hasHeaders: false,
            logicalPath: "tools/read.ts",
            protocol: "mcp",
            sourceId: "read-tool",
            sourceKind: "module",
            url: "https://example.com/mcp",
          },
        ],
        sourceComposition: {
          disabled: [],
          selected: [{ slot: "tools/read", sourceId: "read-tool", sourceKind: "module" }],
          shadowed: [],
        },
      }),
    ).toThrow(/projects source "read-tool" as connections/u);
  });

  it("rejects duplicate primitive projections for one selected source", () => {
    const tool = {
      description: "Reads data.",
      hasAuth: false,
      hasExecute: true,
      hasModelOutputProjection: false,
      inputSchema: null,
      logicalPath: "tools/read.ts",
      name: "read",
      requiresApproval: false,
      sourceId: "read-tool",
      sourceKind: "module" as const,
    };
    expect(() =>
      createCompiledAgentResources({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: {
          "read-tool": {
            backing: {
              kind: "programmatic",
              moduleId: "tools/read.ts",
              registryId: "test",
              revision: "test-v1",
            },
            logicalPath: tool.logicalPath,
            owner: { kind: "application" },
          },
        },
        sourceComposition: {
          disabled: [],
          selected: [{ slot: "tools/read", sourceId: tool.sourceId, sourceKind: "module" }],
          shadowed: [],
        },
        tools: [tool, tool],
      }),
    ).toThrow('projects source "read-tool" as a tool more than once');
  });

  it("rejects duplicate public identities before hydration", () => {
    const createTool = (sourceId: string, logicalPath: string) => ({
      description: "Reads data.",
      hasAuth: false,
      hasExecute: true,
      hasModelOutputProjection: false,
      inputSchema: null,
      logicalPath,
      name: "read",
      requiresApproval: false,
      sourceId,
      sourceKind: "module" as const,
    });
    expect(() =>
      createCompiledAgentResources({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: Object.fromEntries(
          ["one", "two"].map((sourceId) => [
            sourceId,
            {
              backing: {
                kind: "programmatic" as const,
                moduleId: `tools/${sourceId}.ts`,
                registryId: "test",
                revision: "test-v1",
              },
              logicalPath: `tools/${sourceId}.ts`,
              owner: { kind: "application" as const },
            },
          ]),
        ),
        sourceComposition: {
          disabled: [],
          selected: ["one", "two"].map((sourceId) => ({
            slot: `tools/${sourceId}`,
            sourceId,
            sourceKind: "module" as const,
          })),
          shadowed: [],
        },
        tools: [createTool("one", "tools/one.ts"), createTool("two", "tools/two.ts")],
      }),
    ).toThrow('gives tool identity "read" to both "one" and "two"');
  });

  it("requires every source-backed model reference to match the selected config export", () => {
    expect(() =>
      createCompiledAgentNodeManifest({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: {
          config: {
            backing: {
              kind: "programmatic",
              moduleId: "agent.ts",
              registryId: "test",
              revision: "test-v1",
            },
            logicalPath: "agent.ts",
            owner: { kind: "application" },
          },
          tool: {
            backing: {
              kind: "programmatic",
              moduleId: "tools/model.ts",
              registryId: "test",
              revision: "test-v1",
            },
            logicalPath: "tools/model.ts",
            owner: { kind: "application" },
          },
        },
        config: {
          model: {
            id: "openai/gpt-5-mini",
            routing: { kind: "gateway", target: "openai" },
            source: {
              exportName: "model",
              logicalPath: "tools/model.ts",
              sourceId: "tool",
              sourceKind: "module",
            },
          },
          name: "node",
          source: {
            exportName: "agent",
            logicalPath: "agent.ts",
            sourceId: "config",
            sourceKind: "module",
          },
        },
        sourceComposition: {
          disabled: [],
          selected: [
            { slot: "agent", sourceId: "config", sourceKind: "module" },
            { slot: "tools/model", sourceId: "tool", sourceKind: "module" },
          ],
          shadowed: [],
        },
        tools: [
          {
            description: "Returns a model.",
            exportName: "model",
            hasAuth: false,
            hasExecute: true,
            hasModelOutputProjection: false,
            inputSchema: null,
            logicalPath: "tools/model.ts",
            name: "model",
            requiresApproval: false,
            sourceId: "tool",
            sourceKind: "module",
          },
        ],
      }),
    ).toThrow(/model source must exactly match config source "agent\.ts#agent"/u);
  });

  it("rejects extension-owned filesystem bindings without extension scope", () => {
    expect(() =>
      createResources({
        [EXTENSION_SOURCE_ID]: createExtensionBinding({
          backing: {
            externalDependencies: [],
            kind: "filesystem",
            sourcePath: "/packages/crm/extension/tools/search.ts",
          },
        }),
      }),
    ).toThrow("without an extension scope");
  });

  it.each([
    {
      expected: 'binds framework feature "eve.feature" to programmatic registry "eve.other"',
      owner: { feature: "eve.feature", kind: "framework" } as const,
      registryId: "eve.other",
    },
    {
      expected: `records reserved framework registry "${FRAMEWORK_AGENT_SOURCE_ID}" as application-owned`,
      owner: { kind: "application" } as const,
      registryId: FRAMEWORK_AGENT_SOURCE_ID,
    },
  ])("rejects programmatic bindings with false framework provenance", (input) => {
    expect(() =>
      createCompiledAgentResources({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: {
          tool: {
            backing: {
              kind: "programmatic",
              moduleId: "tools/read.ts",
              registryId: input.registryId,
              revision: "test-v1",
            },
            logicalPath: "tools/read.ts",
            owner: input.owner,
          },
        },
        sourceComposition: {
          disabled: [],
          selected: [{ slot: "tools/read", sourceId: "tool", sourceKind: "module" }],
          shadowed: [],
        },
        tools: [
          {
            description: "Reads data.",
            hasAuth: false,
            hasExecute: true,
            hasModelOutputProjection: false,
            inputSchema: null,
            logicalPath: "tools/read.ts",
            name: "read",
            requiresApproval: false,
            sourceId: "tool",
            sourceKind: "module",
          },
        ],
      }),
    ).toThrow(input.expected);
  });

  it("rejects a shadow winner borrowed from another slot", () => {
    expect(() =>
      createCompiledAgentResources({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: {
          first: {
            backing: {
              kind: "programmatic",
              moduleId: "first",
              registryId: "test",
              revision: "test-revision",
            },
            logicalPath: "tools/first.ts",
            owner: { kind: "application" },
          },
          second: {
            backing: {
              kind: "programmatic",
              moduleId: "second",
              registryId: "test",
              revision: "test-revision",
            },
            logicalPath: "tools/second.ts",
            owner: { kind: "application" },
          },
        },
        sourceComposition: {
          disabled: [],
          selected: [
            { slot: "tools/first", sourceId: "first", sourceKind: "module" },
            { slot: "tools/second", sourceId: "second", sourceKind: "module" },
          ],
          shadowed: [
            {
              slot: "tools/first",
              source: {
                backing: {
                  kind: "programmatic",
                  moduleId: "loser",
                  registryId: "test",
                  revision: "test-revision",
                },
                layer: "framework-default",
                logicalPath: "tools/first.js",
                owner: { feature: "test", kind: "framework" },
                sourceId: "loser",
                sourceKind: "module",
              },
              winningSourceId: "second",
            },
          ],
        },
      }),
    ).toThrow('slot "tools/first" with "second", but that slot is won by "first"');
  });

  it("rejects duplicate shadow records", () => {
    const shadowed = {
      slot: "tools/first",
      source: {
        backing: {
          kind: "programmatic" as const,
          moduleId: "loser",
          registryId: "test",
          revision: "test-revision",
        },
        layer: "framework-default" as const,
        logicalPath: "tools/first.js",
        owner: { feature: "test", kind: "framework" as const },
        sourceId: "loser",
        sourceKind: "module" as const,
      },
      winningSourceId: "first",
    };

    expect(() =>
      createCompiledAgentResources({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: {
          first: {
            backing: {
              kind: "programmatic",
              moduleId: "first",
              registryId: "test",
              revision: "test-revision",
            },
            logicalPath: "tools/first.ts",
            owner: { kind: "application" },
          },
        },
        sourceComposition: {
          disabled: [],
          selected: [{ slot: "tools/first", sourceId: "first", sourceKind: "module" }],
          shadowed: [shadowed, shadowed],
        },
      }),
    ).toThrow('records shadowed source "loser" more than once');
  });

  it("validates node config references during node construction", () => {
    expect(() =>
      createCompiledAgentNodeManifest(
        {
          agentRoot: "/app/agent",
          appRoot: "/app",
          bindings: {},
          sourceComposition: {
            disabled: [],
            selected: [{ slot: "agent", sourceId: "agent-config", sourceKind: "module" }],
            shadowed: [],
          },
          config: {
            model: {
              id: "openai/gpt-5-mini",
              routing: { kind: "gateway", target: "openai" },
            },
            name: "node",
            source: {
              logicalPath: "agent.ts",
              sourceId: "agent-config",
              sourceKind: "module",
            },
          },
        },
        { nodeId: "subagents/reviewer" },
      ),
    ).toThrow('Compiled node "subagents/reviewer" is missing a binding for "agent-config"');
  });

  it("validates edge-owned dynamic resolver bindings during root construction", () => {
    const configResolver = {
      eventNames: ["turn.started"],
      logicalPath: "agent.ts",
      sourceId: "dynamic-config",
      sourceKind: "module" as const,
    };
    const child = createCompiledAgentResources(
      {
        agentRoot: "/app/agent/subagents/researcher",
        appRoot: "/app",
        bindings: {
          "dynamic-config": {
            backing: {
              kind: "programmatic",
              moduleId: "dynamic-config",
              registryId: "test",
              revision: "test-revision",
            },
            logicalPath: "agent.ts",
            owner: { kind: "application" },
          },
        },
        sourceComposition: {
          disabled: [],
          selected: [{ slot: "agent", sourceId: "dynamic-config", sourceKind: "module" }],
          shadowed: [],
        },
      },
      { additionalBindingReferences: [configResolver], nodeId: "researcher" },
    );

    expect(() =>
      createCompiledAgentManifest({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: {
          "root-agent-config": {
            backing: {
              kind: "programmatic",
              moduleId: "agent.ts",
              registryId: "test",
              revision: "test-revision",
            },
            logicalPath: "agent.ts",
            owner: { kind: "application" },
          },
        },
        sourceComposition: {
          disabled: [],
          selected: [{ slot: "agent", sourceId: "root-agent-config", sourceKind: "module" }],
          shadowed: [],
        },
        config: {
          model: {
            id: "openai/gpt-5-mini",
            routing: { kind: "gateway", target: "openai" },
          },
          name: "root",
          source: {
            logicalPath: "agent.ts",
            sourceId: "root-agent-config",
            sourceKind: "module",
          },
        },
        subagentEdges: [{ childNodeId: "researcher", parentNodeId: "__root__" }],
        subagents: [
          {
            agent: { ...child, bindings: {} },
            backing: {
              externalDependencies: [],
              kind: "filesystem",
              sourcePath: "/app/agent/subagents/researcher/agent.ts",
            },
            configResolver,
            entryPath: "/app/agent/subagents/researcher/agent.ts",
            logicalPath: "subagents/researcher",
            name: "researcher",
            nodeId: "researcher",
            owner: { kind: "application" },
            rootPath: "/app/agent/subagents/researcher",
            sourceId: "researcher",
            sourceKind: "subagent",
          },
        ],
      }),
    ).toThrow('Compiled node "researcher" is missing a binding for "dynamic-config"');
  });

  it("rejects a serialized dynamic config resolver projected from a non-agent slot", () => {
    const configResolver = {
      eventNames: ["turn.started"],
      logicalPath: "agent.ts",
      sourceId: "dynamic-config",
      sourceKind: "module" as const,
    };
    const child = createCompiledAgentResources(
      {
        agentRoot: "/app/agent/subagents/researcher",
        appRoot: "/app",
        bindings: {
          "dynamic-config": {
            backing: {
              kind: "programmatic",
              moduleId: "dynamic-config",
              registryId: "test",
              revision: "test-revision",
            },
            logicalPath: configResolver.logicalPath,
            owner: { kind: "application" },
          },
        },
        sourceComposition: {
          disabled: [],
          selected: [{ slot: "agent", sourceId: "dynamic-config", sourceKind: "module" }],
          shadowed: [],
        },
      },
      {
        additionalBindingReferences: [configResolver],
        nodeId: "researcher",
      },
    );
    const subagentBacking = {
      externalDependencies: [],
      kind: "filesystem" as const,
      sourcePath: "/app/agent/subagents/researcher/agent.ts",
    };
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: {
        "root-agent-config": {
          backing: {
            kind: "programmatic",
            moduleId: "agent.ts",
            registryId: "test",
            revision: "test-revision",
          },
          logicalPath: "agent.ts",
          owner: { kind: "application" },
        },
      },
      config: {
        model: {
          id: "openai/gpt-5-mini",
          routing: { kind: "gateway", target: "openai" },
        },
        name: "root",
        source: {
          logicalPath: "agent.ts",
          sourceId: "root-agent-config",
          sourceKind: "module",
        },
      },
      sourceComposition: {
        disabled: [],
        selected: [
          { slot: "agent", sourceId: "root-agent-config", sourceKind: "module" },
          {
            slot: "subagents/researcher",
            source: {
              backing: subagentBacking,
              layer: "application",
              logicalPath: "subagents/researcher",
              owner: { kind: "application" },
              sourceId: "researcher",
              sourceKind: "subagent",
            },
            sourceKind: "non-module",
          },
        ],
        shadowed: [],
      },
      subagentEdges: [{ childNodeId: "researcher", parentNodeId: "__root__" }],
      subagents: [
        {
          agent: child,
          backing: subagentBacking,
          configResolver,
          entryPath: "/app/agent/subagents/researcher/agent.ts",
          logicalPath: "subagents/researcher",
          name: "researcher",
          nodeId: "researcher",
          owner: { kind: "application" },
          rootPath: "/app/agent/subagents/researcher",
          sourceId: "researcher",
          sourceKind: "subagent",
        },
      ],
    });
    const malformedLogicalPath = "tools/config.ts";
    const malformed = {
      ...manifest,
      subagents: manifest.subagents.map((subagent) =>
        subagent.nodeId === "researcher" && subagent.configResolver !== undefined
          ? {
              ...subagent,
              agent: {
                ...subagent.agent,
                bindings: {
                  ...subagent.agent.bindings,
                  [configResolver.sourceId]: {
                    ...subagent.agent.bindings[configResolver.sourceId]!,
                    logicalPath: malformedLogicalPath,
                  },
                },
                sourceComposition: {
                  ...subagent.agent.sourceComposition,
                  selected: subagent.agent.sourceComposition.selected.map((selected) =>
                    selected.sourceKind === "module" &&
                    selected.sourceId === configResolver.sourceId
                      ? { ...selected, slot: "tools/config" }
                      : selected,
                  ),
                },
              },
              configResolver: {
                ...subagent.configResolver,
                logicalPath: malformedLogicalPath,
              },
            }
          : subagent,
      ),
    };

    const structural = compiledAgentManifestSchema.safeParse(malformed);
    expect(
      structural.success,
      structural.success ? "" : JSON.stringify(structural.error.issues),
    ).toBe(true);
    expect(() => parseCompiledAgentManifest(malformed)).toThrow(
      'Compiled dynamic node "researcher" config resolver "dynamic-config" is not its selected config source.',
    );
  });

  it("validates persisted remote owner and backing against the selected subagent source", () => {
    const structuralBacking = {
      externalDependencies: [],
      kind: "filesystem" as const,
      sourcePath: "/app/agent/subagents/reviewer.ts",
    };
    const configResolver = {
      logicalPath: "subagents/reviewer/agent.ts",
      sourceId: "reviewer::config",
      sourceKind: "module" as const,
    };
    const remoteBacking = {
      externalDependencies: [],
      kind: "filesystem" as const,
      sourcePath: "/app/agent/subagents/reviewer-v2.ts",
    };

    expect(() =>
      createCompiledAgentManifest({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: {
          "root-agent-config": {
            backing: {
              kind: "programmatic",
              moduleId: "agent.ts",
              registryId: "test",
              revision: "test-revision",
            },
            logicalPath: "agent.ts",
            owner: { kind: "application" },
          },
        },
        config: {
          model: {
            id: "openai/gpt-5-mini",
            routing: { kind: "gateway", target: "openai" },
          },
          name: "root",
          source: {
            logicalPath: "agent.ts",
            sourceId: "root-agent-config",
            sourceKind: "module",
          },
        },
        remoteAgents: [
          {
            backing: remoteBacking,
            bindings: {
              [configResolver.sourceId]: {
                backing: remoteBacking,
                logicalPath: configResolver.logicalPath,
                owner: { kind: "application" },
              },
            },
            configResolver,
            description: "Reviews responses.",
            entryPath: remoteBacking.sourcePath,
            logicalPath: "subagents/reviewer",
            name: "reviewer",
            nodeId: "reviewer",
            owner: { kind: "application" },
            path: "/eve/v1/session",
            rootPath: "/app/agent",
            sourceId: "reviewer",
            sourceKind: "subagent",
            sourceComposition: {
              disabled: [],
              selected: [
                {
                  slot: "subagents/reviewer/agent",
                  sourceId: configResolver.sourceId,
                  sourceKind: "module",
                },
              ],
              shadowed: [],
            },
            url: "https://reviewer.example.com",
          },
        ],
        sourceComposition: {
          disabled: [],
          selected: [
            {
              slot: "agent",
              sourceId: "root-agent-config",
              sourceKind: "module",
            },
            {
              slot: "subagents/reviewer",
              source: {
                backing: structuralBacking,
                layer: "application",
                logicalPath: "subagents/reviewer",
                owner: { kind: "application" },
                sourceId: "reviewer",
                sourceKind: "subagent",
              },
              sourceKind: "non-module",
            },
          ],
          shadowed: [],
        },
      }),
    ).toThrow('remote subagent "reviewer" does not preserve its selected owner and backing');
  });

  it("rejects a remote config scope whose backing differs from its structural source", () => {
    const sourceBacking = {
      externalDependencies: [],
      kind: "filesystem" as const,
      sourcePath: "/app/agent/subagents/reviewer.ts",
    };
    const remote = createTestCompiledRemoteAgentNode({
      backing: sourceBacking,
      configBinding: {
        backing: {
          ...sourceBacking,
          sourcePath: "/live/agent/subagents/reviewer.ts",
        },
        logicalPath: "subagents/reviewer.ts",
        owner: { kind: "application" },
      },
      configResolver: {
        logicalPath: "subagents/reviewer.ts",
        sourceId: "subagents/reviewer",
        sourceKind: "module",
      },
      description: "Reviews responses.",
      entryPath: sourceBacking.sourcePath,
      logicalPath: "subagents/reviewer",
      name: "reviewer",
      nodeId: "subagents/reviewer",
      owner: { kind: "application" },
      path: "/eve/v1/session",
      rootPath: "/app/agent",
      sourceId: "subagents/reviewer",
      sourceKind: "subagent",
    });

    expect(() =>
      createStubCompiledAgentManifest({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
        config: {
          model: {
            id: "openai/gpt-5.5",
            routing: { kind: "gateway", target: "openai" },
          },
          name: "root",
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        },
        remoteAgents: [remote],
      }),
    ).toThrow(
      'Compiled remote agent "subagents/reviewer" config binding does not preserve its source backing.',
    );
  });

  it("validates external dependency references in remote module scopes", () => {
    const backing = {
      externalDependencies: ["missing-package"],
      kind: "filesystem" as const,
      sourcePath: "/app/agent/subagents/reviewer.ts",
    };
    const remote = createTestCompiledRemoteAgentNode({
      backing,
      configBinding: {
        backing,
        logicalPath: "subagents/reviewer.ts",
        owner: { kind: "application" },
      },
      configResolver: {
        logicalPath: "subagents/reviewer.ts",
        sourceId: "subagents/reviewer",
        sourceKind: "module",
      },
      description: "Reviews responses.",
      entryPath: backing.sourcePath,
      logicalPath: "subagents/reviewer",
      name: "reviewer",
      nodeId: "subagents/reviewer",
      owner: { kind: "application" },
      path: "/eve/v1/session",
      rootPath: "/app/agent",
      sourceId: "subagents/reviewer",
      sourceKind: "subagent",
    });

    expect(() =>
      createStubCompiledAgentManifest({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
        config: {
          model: {
            id: "openai/gpt-5.5",
            routing: { kind: "gateway", target: "openai" },
          },
          name: "root",
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        },
        remoteAgents: [remote],
      }),
    ).toThrow(
      'Compiled node "subagents/reviewer" binding "subagents/reviewer" references missing external dependency plan entry "missing-package".',
    );
  });

  it("requires stored remote node ids to use the canonical injective encoding", () => {
    const backing = {
      externalDependencies: [],
      kind: "filesystem" as const,
      sourcePath: "/app/agent/subagents/a::b.ts",
    };
    const remote = createTestCompiledRemoteAgentNode({
      backing,
      configBinding: {
        backing,
        logicalPath: "subagents/a::b.ts",
        owner: { kind: "application" },
      },
      configResolver: {
        logicalPath: "subagents/a::b.ts",
        sourceId: "subagents/a::b",
        sourceKind: "module",
      },
      description: "Reviews responses.",
      entryPath: backing.sourcePath,
      logicalPath: "subagents/reviewer",
      name: "reviewer",
      nodeId: "subagents/a::b",
      owner: { kind: "application" },
      path: "/eve/v1/session",
      rootPath: "/app/agent",
      sourceId: "subagents/a::b",
      sourceKind: "subagent",
    });

    expect(() =>
      createStubCompiledAgentManifest({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
        config: {
          model: {
            id: "openai/gpt-5.5",
            routing: { kind: "gateway", target: "openai" },
          },
          name: "root",
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        },
        remoteAgents: [remote],
      }),
    ).toThrow(
      'Compiled remote subagent node id "subagents/a::b" does not match canonical id "subagents/a%3A%3Ab"',
    );
  });
});
