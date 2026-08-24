import { describe, expect, it } from "vitest";

import {
  COMPILED_AGENT_MANIFEST_VERSION,
  compiledAgentManifestSchema,
  createCompiledAgentManifest as createCompiledAgentManifestBase,
  createCompiledAgentNodeManifest as createCompiledAgentNodeManifestBase,
} from "#compiler/manifest.js";
import { CHANNEL_ROUTE_INVALID_PATTERN_DIAGNOSTIC_CODE } from "#compiler/channel-route-plan.js";
import { collectCompiledManifestKernelSemanticIssues } from "#compiler/kernel-plan-semantics.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";
import {
  createStubCompiledAgentManifest as createCompiledAgentManifest,
  createStubCompiledAgentNodeManifest as createCompiledAgentNodeManifest,
  createTestCompiledAgentResources as createCompiledAgentResources,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
} from "#internal/testing/compiled-manifest.js";

describe("compiledAgentManifestSchema", () => {
  it("rejects the previous manifest version without compatibility repair", () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });

    expect(
      compiledAgentManifestSchema.safeParse({
        ...manifest,
        version: COMPILED_AGENT_MANIFEST_VERSION - 1,
      }).success,
    ).toBe(false);
  });

  it("rejects an empty persisted module semantic revision", () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });
    const sourceId = manifest.config.source.sourceId;
    const binding = manifest.bindings[sourceId]!;

    expect(
      compiledAgentManifestSchema.safeParse({
        ...manifest,
        bindings: {
          ...manifest.bindings,
          [sourceId]: {
            ...binding,
            backing: {
              kind: "programmatic",
              moduleId: binding.logicalPath,
              registryId: "test",
              revision: "source-v1",
              semanticRevision: "",
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it.each(["", "not-a-digest", "A".repeat(64), "0".repeat(63)])(
    "rejects a non-canonical sandbox source identity %j",
    (sourceHash) => {
      const manifest = createCompiledAgentManifest({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
        config: {
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
          model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
          name: "app",
        },
      });

      expect(
        compiledAgentManifestSchema.safeParse({
          ...manifest,
          sandbox: { ...manifest.sandbox, sourceHash },
        }).success,
      ).toBe(false);
    },
  );

  it.each(["", "not-a-digest", "A".repeat(64), "0".repeat(63)])(
    "rejects a non-canonical workspace content identity %j",
    (contentHash) => {
      const manifest = createCompiledAgentManifest({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
        config: {
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
          model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
          name: "app",
        },
      });

      expect(
        compiledAgentManifestSchema.safeParse({
          ...manifest,
          workspaceResourceRoot: { ...manifest.workspaceResourceRoot, contentHash },
        }).success,
      ).toBe(false);
    },
  );

  it("requires serialized inspection metadata without compatibility defaults", () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        { logicalPath: "connections/crm.ts", sourceId: "opaque:connection" },
        { logicalPath: "hooks/audit.ts", sourceId: "opaque:hook" },
        { logicalPath: "tools/search.ts", sourceId: "opaque:tool" },
      ],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
      connections: [
        {
          connectionName: "crm",
          description: "CRM",
          logicalPath: "connections/crm.ts",
          protocol: "mcp",
          sourceId: "opaque:connection",
          sourceKind: "module",
          url: "https://crm.example/mcp",
        },
      ],
      hooks: [
        {
          logicalPath: "hooks/audit.ts",
          slug: "audit",
          sourceId: "opaque:hook",
          sourceKind: "module",
        },
      ],
      tools: [
        {
          description: "Search.",
          inputSchema: null,
          logicalPath: "tools/search.ts",
          name: "search",
          sourceId: "opaque:tool",
          sourceKind: "module",
        },
      ],
    });
    const { hasAuth: _hasAuth, ...toolWithoutMetadata } = manifest.tools[0]!;
    const { hasApproval: _hasApproval, ...connectionWithoutMetadata } = manifest.connections[0]!;
    const { protocol: _protocol, ...connectionWithoutProtocol } = manifest.connections[0]!;
    const { eventNames: _eventNames, ...hookWithoutMetadata } = manifest.hooks[0]!;
    const { hasBootstrap: _hasBootstrap, ...sandboxWithoutMetadata } = manifest.sandbox;

    expect(
      compiledAgentManifestSchema.safeParse({ ...manifest, tools: [toolWithoutMetadata] }).success,
    ).toBe(false);
    expect(
      compiledAgentManifestSchema.safeParse({
        ...manifest,
        connections: [connectionWithoutMetadata],
      }).success,
    ).toBe(false);
    expect(
      compiledAgentManifestSchema.safeParse({
        ...manifest,
        connections: [connectionWithoutProtocol],
      }).success,
    ).toBe(false);
    expect(
      compiledAgentManifestSchema.safeParse({ ...manifest, hooks: [hookWithoutMetadata] }).success,
    ).toBe(false);
    expect(
      compiledAgentManifestSchema.safeParse({ ...manifest, sandbox: sandboxWithoutMetadata })
        .success,
    ).toBe(false);
  });

  it.each([
    "dynamicInstructions",
    "dynamicSkills",
    "dynamicTools",
    "extensionMounts",
    "instructions",
  ] as const)("rejects a current manifest missing required %s", (field) => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });
    const malformed = Object.fromEntries(
      Object.entries(manifest).filter(([name]) => name !== field),
    );

    expect(compiledAgentManifestSchema.safeParse(malformed).success).toBe(false);
  });

  it("requires config provenance in the versioned artifact schema", () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });
    const { source: _source, ...configWithoutSource } = manifest.config;

    expect(
      compiledAgentManifestSchema.safeParse({ ...manifest, config: configWithoutSource }).success,
    ).toBe(false);
  });

  it.each([
    {
      bindings: [],
      message:
        'Test compiled agent config source "test:stub-agent-config" requires an explicit binding.',
    },
    {
      bindings: [{ ...TEST_COMPILED_AGENT_CONFIG_BINDING, logicalPath: "config/agent.ts" }],
      message:
        'Test compiled agent config source "test:stub-agent-config" uses logical path "agent.ts", but its binding uses "config/agent.ts".',
    },
  ])("rejects test config provenance without its exact binding", ({ bindings, message }) => {
    expect(() =>
      createCompiledAgentManifest({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings,
        config: {
          model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
          name: "app",
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        },
      }),
    ).toThrow(message);
  });

  it("rejects named-export fields on non-module static definitions", () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
      instructions: [
        {
          content: "Markdown instructions.",
          logicalPath: "instructions.md",
          name: "instructions",
          role: "system",
          sourceId: "instructions.md",
          sourceKind: "markdown",
        },
      ],
      schedules: [
        {
          cron: "0 9 * * *",
          hasRun: false,
          logicalPath: "schedules/digest.md",
          markdown: "Send a digest.",
          name: "digest",
          sourceId: "schedules/digest.md",
          sourceKind: "markdown",
        },
      ],
    });

    expect(
      compiledAgentManifestSchema.safeParse({
        ...manifest,
        instructions: [{ ...manifest.instructions[0]!, exportName: "impossible" }],
      }).success,
    ).toBe(false);
    expect(
      compiledAgentManifestSchema.safeParse({
        ...manifest,
        schedules: [{ ...manifest.schedules[0]!, exportName: "impossible" }],
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      "a non-agent logical slot",
      { logicalPath: "tools/config.ts", sourceId: "test:stub-agent-config" },
    ],
    ["a different selected source", { logicalPath: "agent.ts", sourceId: "other-config" }],
  ])("rejects config provenance pointing at %s", (_, sourceOverride) => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });

    expect(() =>
      createCompiledAgentManifestBase({
        ...manifest,
        config: { ...manifest.config, source: { ...manifest.config.source, ...sourceOverride } },
      }),
    ).toThrow();
  });

  it("rejects compiled manifests without a selected sandbox", () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });

    expect(compiledAgentManifestSchema.safeParse({ ...manifest, sandbox: null }).success).toBe(
      false,
    );
  });

  it("accepts authored HEAD and OPTIONS channel routes", () => {
    const channel = {
      adapterKind: "mcp",
      kind: "channel" as const,
      logicalPath: "channels/mcp.ts",
      name: "mcp",
      sourceId: "channel-mcp",
      sourceKind: "module" as const,
      urlPath: "/.well-known/oauth-protected-resource",
    };
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        { logicalPath: "channels/mcp.ts", sourceId: "channel-mcp" },
      ],
      channelRoutes: {
        effective: [
          { ...channel, method: "HEAD" },
          { ...channel, method: "OPTIONS" },
        ],
        preflight: [],
        shadowed: [],
      },
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });

    const parsed = compiledAgentManifestSchema.parse(manifest);
    expect(parsed.channelRoutes.effective.map((entry) => entry.method)).toEqual([
      "HEAD",
      "OPTIONS",
    ]);
  });

  it("rejects invalid channel patterns at construction and artifact load", () => {
    const channel = {
      kind: "channel" as const,
      logicalPath: "channels/hooks.ts",
      method: "GET" as const,
      name: "hooks",
      sourceId: "channel-hooks",
      sourceKind: "module" as const,
      urlPath: "/hooks",
    };
    const input = {
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        { logicalPath: channel.logicalPath, sourceId: channel.sourceId },
      ],
      channelRoutes: { effective: [channel], preflight: [], shadowed: [] },
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    } as const;

    expect(() =>
      createCompiledAgentManifest({
        ...input,
        channelRoutes: {
          ...input.channelRoutes,
          effective: [{ ...channel, urlPath: "/hooks/*" }],
        },
      }),
    ).toThrow(CHANNEL_ROUTE_INVALID_PATTERN_DIAGNOSTIC_CODE);

    const manifest = createCompiledAgentManifest(input);
    const parsed = compiledAgentManifestSchema.safeParse({
      ...manifest,
      channelRoutes: {
        ...manifest.channelRoutes,
        effective: [{ ...manifest.channelRoutes.effective[0]!, urlPath: "/hooks/:id?" }],
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual([
        expect.objectContaining({
          message: expect.stringContaining(CHANNEL_ROUTE_INVALID_PATTERN_DIAGNOSTIC_CODE),
        }),
      ]);
    }
  });

  it("attributes forbidden child route plans to the exact compiled node", () => {
    const node = createCompiledAgentNodeManifest(
      {
        agentRoot: "/app/agent/subagents/reviewer",
        appRoot: "/app",
        bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
        config: {
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
          model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
          name: "reviewer",
        },
      },
      { isRoot: false, nodeId: "subagents/reviewer" },
    );
    const route = {
      kind: "channel" as const,
      logicalPath: "channels/review.ts",
      method: "GET" as const,
      name: "review",
      sourceId: "channel-review",
      sourceKind: "module" as const,
      urlPath: "/review",
    };

    expect(() =>
      createCompiledAgentNodeManifestBase(
        {
          ...node,
          channelRoutes: { effective: [route], preflight: [], shadowed: [] },
        },
        { isRoot: false, nodeId: "subagents/reviewer" },
      ),
    ).toThrow('Compiled child node "subagents/reviewer" retains root-only channel routes');
  });

  it("rejects non-canonical trailing slashes in loaded channel plans", () => {
    const channel = {
      kind: "channel" as const,
      logicalPath: "channels/hooks.ts",
      method: "GET" as const,
      name: "hooks",
      sourceId: "channel-hooks",
      sourceKind: "module" as const,
      urlPath: "/hooks",
    };
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        { logicalPath: channel.logicalPath, sourceId: channel.sourceId },
      ],
      channelRoutes: { effective: [channel], preflight: [], shadowed: [] },
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });

    expect(
      compiledAgentManifestSchema.safeParse({
        ...manifest,
        channelRoutes: {
          ...manifest.channelRoutes,
          effective: [{ ...manifest.channelRoutes.effective[0]!, urlPath: "/hooks/" }],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects incomplete preflight cause sets at construction", () => {
    const cors = { origin: ["https://example.com"] } as const;
    const get = {
      cors,
      kind: "channel" as const,
      logicalPath: "channels/get.ts",
      method: "GET" as const,
      name: "get",
      sourceId: "channel-get",
      sourceKind: "module" as const,
      urlPath: "/hooks/:id",
    };
    const post = {
      ...get,
      logicalPath: "channels/post.ts",
      method: "POST" as const,
      name: "post",
      sourceId: "channel-post",
      urlPath: "/hooks/:name",
    };

    expect(() =>
      createCompiledAgentManifest({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: [
          TEST_COMPILED_AGENT_CONFIG_BINDING,
          { logicalPath: get.logicalPath, sourceId: get.sourceId },
          { logicalPath: post.logicalPath, sourceId: post.sourceId },
        ],
        channelRoutes: {
          effective: [get, post],
          preflight: [{ cors, pathPattern: get.urlPath, sourceIds: [get.sourceId] }],
          shadowed: [],
        },
        config: {
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
          model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
          name: "app",
        },
      }),
    ).toThrow("dangling causes");
  });

  it.each([
    ["origin", { origin: [""] }],
    ["methods", { methods: [""] }],
    ["allowHeaders", { allowHeaders: [""] }],
    ["exposeHeaders", { exposeHeaders: [""] }],
    ["maxAge", { maxAge: "" }],
  ] as const)("rejects an invalid normalized CORS %s value at construction", (_, cors) => {
    const channel = {
      cors,
      kind: "channel" as const,
      logicalPath: "channels/hooks.ts",
      method: "GET" as const,
      name: "hooks",
      sourceId: "channel-hooks",
      sourceKind: "module" as const,
      urlPath: "/hooks",
    };

    expect(() =>
      createCompiledAgentManifest({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: [
          TEST_COMPILED_AGENT_CONFIG_BINDING,
          { logicalPath: channel.logicalPath, sourceId: channel.sourceId },
        ],
        channelRoutes: { effective: [channel], preflight: [], shadowed: [] },
        config: {
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
          model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
          name: "app",
        },
      }),
    ).toThrow("invalid normalized CORS");
  });

  it("requires exactly one static description or dynamic resolver for each subagent", () => {
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });
    const subagent = {
      agent: createCompiledAgentNodeManifest(
        {
          kernelPlan: { prepared: [] },
          agentRoot: "/app/agent/subagents/research",
          appRoot: "/app",
          bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
          config: {
            source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
            model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
            name: "research",
          },
        },
        { isRoot: false, nodeId: "research" },
      ),
      backing: {
        externalDependencies: [],
        kind: "filesystem",
        sourcePath: "/app/agent/subagents/research/agent.ts",
      },
      entryPath: "subagents/research/agent.ts",
      logicalPath: "subagents/research",
      name: "research",
      nodeId: "research",
      owner: { kind: "application" },
      rootPath: "/app/agent/subagents/research",
      sourceId: "subagents/research/agent.ts",
      sourceKind: "subagent",
    } as const;
    const parses = (variant: Readonly<Record<string, unknown>>): boolean =>
      compiledAgentManifestSchema.safeParse({
        ...manifest,
        subagents: [{ ...subagent, ...variant }],
      }).success;

    expect(parses({ description: "Research requests." })).toBe(true);
    expect(
      parses({
        agent: createCompiledAgentResources(
          {
            agentRoot: "/app/agent/subagents/research",
            appRoot: "/app",
            bindings: [{ logicalPath: "agent.ts", sourceId: "agent.ts" }],
            kernelPlan: { prepared: [] },
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
            nodeId: "subagents/research",
          },
        ),
        configResolver: {
          eventNames: ["session.started"],
          logicalPath: "agent.ts",
          sourceId: "agent.ts",
          sourceKind: "module",
        },
      }),
    ).toBe(true);
    expect(parses({})).toBe(false);
    expect(
      parses({
        description: "Research requests.",
        configResolver: {
          eventNames: ["session.started"],
          logicalPath: "agent.ts",
          sourceId: "agent.ts",
          sourceKind: "module",
        },
      }),
    ).toBe(false);
  });

  it("preserves reasoning configuration", () => {
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
        reasoning: "high",
      },
    });

    const parsed = compiledAgentManifestSchema.parse(manifest);

    expect(parsed.config.reasoning).toBe("high");
  });

  it("preserves runtime limits configuration", () => {
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        limits: {
          maxInputTokensPerSession: 200_000,
          maxOutputTokensPerSession: 20_000,
          sessionTimeoutMs: 86_400_000,
        },
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });

    const parsed = compiledAgentManifestSchema.parse(manifest);

    expect(parsed.config.limits).toEqual({
      maxInputTokensPerSession: 200_000,
      maxOutputTokensPerSession: 20_000,
      sessionTimeoutMs: 86_400_000,
    });
  });

  it("rejects the removed maxSubagentDepth limit", () => {
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });

    expect(() =>
      compiledAgentManifestSchema.parse({
        ...manifest,
        config: { ...manifest.config, limits: { maxSubagentDepth: 4 } },
      }),
    ).toThrow();
  });

  it("rejects the removed agent-level maxSubagents limit", () => {
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });

    expect(() =>
      compiledAgentManifestSchema.parse({
        ...manifest,
        config: { ...manifest.config, limits: { maxSubagents: 4 } },
      }),
    ).toThrow();
  });

  it("preserves experimental Workflow tool configuration", () => {
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: ["Workflow"] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
      workflowTool: {
        logicalPath: "tools/workflow.ts",
        maxSubagents: 6,
        sourceId: "test:kernel-workflow",
        sourceKind: "module",
      },
    });

    const parsed = compiledAgentManifestSchema.parse(manifest);

    expect(parsed.workflowTool).toEqual({
      logicalPath: "tools/workflow.ts",
      maxSubagents: 6,
      sourceId: "test:kernel-workflow",
      sourceKind: "module",
    });
  });

  it("preserves web search provider configuration", () => {
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: ["web_search"] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
      webSearchProvider: {
        logicalPath: "tools/web_search.ts",
        provider: "exa",
        sourceId: "test:kernel-web-search",
        sourceKind: "module",
      },
    });

    const parsed = compiledAgentManifestSchema.parse(manifest);

    expect(parsed.webSearchProvider).toEqual({
      logicalPath: "tools/web_search.ts",
      provider: "exa",
      sourceId: "test:kernel-web-search",
      sourceKind: "module",
    });
  });

  it("rejects kernel plans that disagree with configured native strategies", () => {
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });

    expect(() =>
      compiledAgentManifestSchema.parse({
        ...manifest,
        workflowTool: {
          logicalPath: "tools/workflow.ts",
          maxSubagents: 6,
          sourceId: "missing-workflow",
          sourceKind: "module",
        },
      }),
    ).toThrow("Workflow configuration without its selected canonical source");
    expect(() =>
      compiledAgentManifestSchema.parse({
        ...manifest,
        webSearchProvider: {
          logicalPath: "tools/web_search.ts",
          provider: "exa",
          sourceId: "missing-web-search",
          sourceKind: "module",
        },
      }),
    ).toThrow("web-search configuration without its selected canonical source");
  });

  it("requires prepared ordinary capabilities to have their canonical compiled resources", () => {
    const config = {
      model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
      name: "app",
      source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
    } as const;
    const tool = {
      description: "Load a skill.",
      inputSchema: null,
      logicalPath: "tools/load_skill.ts",
      name: "load_skill",
      sourceId: "framework:tools/load_skill.ts",
      sourceKind: "module" as const,
    };
    const skill = {
      description: "A test skill.",
      logicalPath: "skills/test/SKILL.md",
      markdown: "# Test",
      name: "test",
      sourceId: "skills/test/SKILL.md",
      sourceKind: "markdown" as const,
    };

    const base = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config,
    });
    expect(() =>
      compiledAgentManifestSchema.parse({
        ...base,
        kernelPlan: {
          prepared: ["agent", "ask_question", "load_skill", "final_output"],
        },
        skills: [skill],
      }),
    ).toThrow(/canonical-framework-tool/u);
    const frameworkBinding = {
      backing: {
        kind: "programmatic" as const,
        moduleId: tool.sourceId,
        registryId: "load-skill",
        revision: "test-compiled-manifest-v1",
      },
      owner: { feature: "load-skill", kind: "framework" as const },
    };
    const noSkills = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        { binding: frameworkBinding, logicalPath: tool.logicalPath, sourceId: tool.sourceId },
      ],
      config,
      tools: [tool],
    });
    expect(() =>
      compiledAgentManifestSchema.parse({
        ...noSkills,
        kernelPlan: {
          prepared: ["agent", "ask_question", "load_skill", "final_output"],
        },
      }),
    ).toThrow(/compiled requirement.*skills/u);
    expect(
      compiledAgentManifestSchema.parse(
        createCompiledAgentManifest({
          agentRoot: "/app/agent",
          appRoot: "/app",
          bindings: [
            TEST_COMPILED_AGENT_CONFIG_BINDING,
            { binding: frameworkBinding, logicalPath: tool.logicalPath, sourceId: tool.sourceId },
          ],
          config,
          skills: [skill],
          tools: [tool],
        }),
      ).kernelPlan.prepared,
    ).toEqual(["agent", "ask_question", "load_skill", "final_output"]);
  });

  it("requires kernel plans to be unique and inventory ordered", () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
      kernelPlan: { prepared: ["agent", "ask_question", "final_output"] },
    });

    expect(compiledAgentManifestSchema.parse(manifest).kernelPlan.prepared).toEqual([
      "agent",
      "ask_question",
      "final_output",
    ]);
    expect(() =>
      compiledAgentManifestSchema.parse({
        ...manifest,
        kernelPlan: { prepared: ["ask_question", "agent"] },
      }),
    ).toThrow("Kernel capability plans must be unique and follow inventory order");
    expect(() =>
      compiledAgentManifestSchema.parse({
        ...manifest,
        kernelPlan: { prepared: ["agent", "agent"] },
      }),
    ).toThrow("Kernel capability plans must be unique and follow inventory order");
  });

  it("rejects unknown persisted capability names without invoking an undefined strategy", () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });
    const invalid = {
      ...manifest,
      kernelPlan: { prepared: ["not-a-kernel-capability" as never] },
    };

    expect(compiledAgentManifestSchema.safeParse(invalid).success).toBe(false);
    expect(() => createCompiledAgentManifestBase(invalid)).toThrow(
      /unknown capability "not-a-kernel-capability"/u,
    );
  });

  it("keeps authored canonical replacements out of framework-native plans", () => {
    const tool = {
      description: "Custom skill loader.",
      inputSchema: null,
      logicalPath: "tools/load_skill.ts",
      name: "load_skill",
      sourceId: "tools/load_skill.ts",
      sourceKind: "module" as const,
    };
    const skill = {
      description: "A test skill.",
      logicalPath: "skills/test/SKILL.md",
      markdown: "# Test",
      name: "test",
      sourceId: "skills/test/SKILL.md",
      sourceKind: "markdown" as const,
    };
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        { logicalPath: tool.logicalPath, sourceId: tool.sourceId },
      ],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
      skills: [skill],
      tools: [tool],
    });
    expect(manifest.kernelPlan.prepared).not.toContain("load_skill");

    const invalid = {
      ...manifest,
      kernelPlan: { prepared: ["agent", "ask_question", "load_skill", "final_output"] as const },
    };
    expect(() => compiledAgentManifestSchema.parse(invalid)).toThrow(/kernel plan must exactly/u);
    expect(() => createCompiledAgentManifestBase(invalid)).toThrow(/kernel plan must exactly/u);
  });

  it("derives a disabled canonical capability identically at construction and schema load", () => {
    const base = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });
    const disabled = {
      slot: "tools/ask_question",
      source: {
        backing: {
          kind: "programmatic" as const,
          moduleId: "disabled:ask-question",
          registryId: "test-compiled-manifest",
          revision: "test-compiled-manifest-v1",
        },
        layer: "application" as const,
        logicalPath: "tools/ask_question.ts",
        owner: { kind: "application" as const },
        sourceId: "disabled:ask-question",
        sourceKind: "module" as const,
      },
    };
    const valid = {
      ...base,
      kernelPlan: { prepared: base.kernelPlan.prepared.filter((name) => name !== "ask_question") },
      sourceComposition: {
        ...base.sourceComposition,
        disabled: [disabled],
      },
    };

    expect(createCompiledAgentManifestBase(valid).kernelPlan.prepared).not.toContain(
      "ask_question",
    );
    expect(compiledAgentManifestSchema.parse(valid).kernelPlan.prepared).not.toContain(
      "ask_question",
    );
    expect(() =>
      createCompiledAgentManifestBase({ ...valid, kernelPlan: base.kernelPlan }),
    ).toThrow(/kernel plan must exactly/u);
  });

  it.each(["tool", "dynamic tool"] as const)(
    "reserves root task control across a task child's %s name before execution",
    (kind) => {
      const binding = { logicalPath: "tools/worker.ts", sourceId: "tools/worker.ts" };
      const child = createCompiledAgentNodeManifest(
        {
          agentRoot: "/app/agent/subagents/research",
          appRoot: "/app",
          bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING, binding],
          config: {
            source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
            model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
            name: "research",
          },
          dynamicTools:
            kind === "dynamic tool"
              ? [
                  {
                    eventNames: ["step.started"],
                    logicalPath: binding.logicalPath,
                    slug: "worker",
                    sourceId: binding.sourceId,
                    sourceKind: "module",
                  },
                ]
              : [],
          tools:
            kind === "tool"
              ? [
                  {
                    description: "Work.",
                    inputSchema: null,
                    logicalPath: binding.logicalPath,
                    name: "worker",
                    sourceId: binding.sourceId,
                    sourceKind: "module",
                  },
                ]
              : [],
        },
        { isRoot: false, nodeId: "subagents/research" },
      );
      const subagent = {
        agent: child,
        backing: {
          externalDependencies: [],
          kind: "filesystem" as const,
          sourcePath: "/app/agent/subagents/research/agent.ts",
        },
        description: "Research requests.",
        entryPath: "/app/agent/subagents/research/agent.ts",
        logicalPath: "subagents/research",
        name: "research",
        nodeId: "subagents/research",
        owner: { kind: "application" as const },
        rootPath: "/app/agent/subagents/research",
        sourceId: "subagents/research",
        sourceKind: "subagent" as const,
      };
      const manifest = createCompiledAgentManifest({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
        config: {
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
          experimental: { tasks: true },
          model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
          name: "app",
        },
        subagentEdges: [{ childNodeId: subagent.nodeId, parentNodeId: "__root__" }],
        subagents: [subagent],
      });
      const invalidAgent = {
        ...child,
        dynamicTools: child.dynamicTools.map((tool) => ({ ...tool, slug: "task_update" })),
        tools: child.tools.map((tool) => ({ ...tool, name: "task_update" })),
      };
      const invalid = {
        ...manifest,
        subagents: [{ ...subagent, agent: invalidAgent }],
      };

      expect(() => createCompiledAgentManifestBase(invalid)).toThrow(
        /reserved session task-control name "task_update"/u,
      );
      expect(() => compiledAgentManifestSchema.parse(invalid)).toThrow(
        /reserved session task-control name/u,
      );
    },
  );

  it("reserves root task control across nested static local child names", () => {
    const grandchild = {
      agent: createCompiledAgentNodeManifest(
        {
          agentRoot: "/app/agent/subagents/research/subagents/task_update",
          appRoot: "/app",
          bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
          config: {
            source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
            model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
            name: "task_update",
          },
        },
        { isRoot: false, nodeId: "subagents/research::subagents/task_update" },
      ),
      backing: {
        externalDependencies: [],
        kind: "filesystem" as const,
        sourcePath: "/app/agent/subagents/research/subagents/task_update/agent.ts",
      },
      description: "Reports task progress.",
      entryPath: "/app/agent/subagents/research/subagents/task_update/agent.ts",
      logicalPath: "subagents/task_update",
      name: "task_update",
      nodeId: "subagents/research::subagents/task_update",
      owner: { kind: "application" as const },
      rootPath: "/app/agent/subagents/research/subagents/task_update",
      sourceId: "subagents/task_update",
      sourceKind: "subagent" as const,
    };
    const child = {
      agent: createCompiledAgentNodeManifest(
        {
          agentRoot: "/app/agent/subagents/research",
          appRoot: "/app",
          bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
          config: {
            source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
            model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
            name: "research",
          },
          subagentSources: [grandchild],
        },
        { isRoot: false, nodeId: "subagents/research" },
      ),
      backing: {
        externalDependencies: [],
        kind: "filesystem" as const,
        sourcePath: "/app/agent/subagents/research/agent.ts",
      },
      description: "Research requests.",
      entryPath: "/app/agent/subagents/research/agent.ts",
      logicalPath: "subagents/research",
      name: "research",
      nodeId: "subagents/research",
      owner: { kind: "application" as const },
      rootPath: "/app/agent/subagents/research",
      sourceId: "subagents/research",
      sourceKind: "subagent" as const,
    };
    const base = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
      subagentEdges: [
        { childNodeId: child.nodeId, parentNodeId: "__root__" },
        { childNodeId: grandchild.nodeId, parentNodeId: child.nodeId },
      ],
      subagents: [child, grandchild],
    });
    const invalid = {
      ...base,
      config: { ...base.config, experimental: { tasks: true } },
      kernelPlan: {
        prepared: ["agent", "task_cancel", "task_update", "ask_question", "final_output"] as const,
      },
    };

    expect(() => createCompiledAgentManifestBase(invalid)).toThrow(
      /reserved session task-control name "task_update"/u,
    );
    expect(() => compiledAgentManifestSchema.parse(invalid)).toThrow(
      /reserved session task-control name/u,
    );

    const spoofedSlot = {
      ...invalid,
      subagents: [
        {
          ...child,
          agent: {
            ...child.agent,
            sourceComposition: {
              ...child.agent.sourceComposition,
              selected: child.agent.sourceComposition.selected.map((entry) =>
                entry.sourceKind === "non-module" && entry.source.sourceId === grandchild.sourceId
                  ? { ...entry, slot: "subagents/not-task-update" }
                  : entry,
              ),
            },
          },
        },
        grandchild,
      ],
    };
    const issues = collectCompiledManifestKernelSemanticIssues(spoofedSlot).map(
      (issue) => issue.message,
    );
    expect(issues).toContain(
      'Compiled node "subagents/research" selected subagent composition does not match explicit subagent "task_update".',
    );
    expect(
      issues.some((issue) => issue.includes('reserved session task-control name "task_update"')),
    ).toBe(true);
  });

  it("rejects serialized child-only session augmentation", () => {
    const child = createCompiledAgentNodeManifest(
      {
        agentRoot: "/app/agent/subagents/research",
        appRoot: "/app",
        bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
        config: {
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
          model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
          name: "research",
        },
      },
      { isRoot: false, nodeId: "subagents/research" },
    );
    const invalid = {
      ...child,
      kernelPlan: { prepared: ["task_update", ...child.kernelPlan.prepared] as const },
    };

    expect(() =>
      compiledAgentManifestSchema.parse({
        ...createCompiledAgentManifest({
          agentRoot: "/app/agent",
          appRoot: "/app",
          bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
          config: {
            source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
            model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
            name: "app",
          },
        }),
        subagents: [
          {
            agent: invalid,
            backing: {
              externalDependencies: [],
              kind: "filesystem",
              sourcePath: "/app/agent/subagents/research/agent.ts",
            },
            description: "Research requests.",
            entryPath: "subagents/research/agent.ts",
            logicalPath: "subagents/research",
            name: "research",
            nodeId: "subagents/research",
            owner: { kind: "application" },
            rootPath: "/app/agent/subagents/research",
            sourceId: "subagents/research",
            sourceKind: "subagent",
          },
        ],
      }),
    ).toThrow(/Compiled node .* kernel plan must exactly equal/u);
  });

  it("preserves dynamic model resolver source", () => {
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [{ logicalPath: "agent.ts", sourceId: "agent-config" }],
      config: {
        source: {
          logicalPath: "agent.ts",
          sourceId: "agent-config",
          sourceKind: "module",
        },
        dynamicModel: {
          eventNames: ["session.started"],
          logicalPath: "agent.ts",
          sourceId: "agent-config",
          sourceKind: "module",
        },
        name: "app",
      },
    });

    const parsed = compiledAgentManifestSchema.parse(manifest);

    expect(parsed.config.dynamicModel).toEqual({
      eventNames: ["session.started"],
      logicalPath: "agent.ts",
      sourceId: "agent-config",
      sourceKind: "module",
    });
    expect(parsed.config.model).toBeUndefined();
  });

  it("rejects compiled configs with both static and dynamic models", () => {
    expect(() =>
      compiledAgentManifestSchema.parse({
        ...createCompiledAgentManifest({
          kernelPlan: { prepared: [] },
          agentRoot: "/app/agent",
          appRoot: "/app",
          bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
          config: {
            source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
            model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
            name: "app",
          },
        }),
        config: {
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
          dynamicModel: {
            eventNames: ["session.started"],
            logicalPath: "agent.ts",
            sourceId: "agent-config",
            sourceKind: "module",
          },
          model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
          name: "app",
        },
      }),
    ).toThrow();
  });

  it("preserves uncapped (false) session token limits", () => {
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        limits: {
          maxInputTokensPerSession: false,
          maxOutputTokensPerSession: false,
          sessionTimeoutMs: false,
        },
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });

    const parsed = compiledAgentManifestSchema.parse(manifest);

    expect(parsed.config.limits).toEqual({
      maxInputTokensPerSession: false,
      maxOutputTokensPerSession: false,
      sessionTimeoutMs: false,
    });
  });

  it("accepts a compiled native workflow world plan", () => {
    const manifest = createCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
      workflowWorld: { kind: "native", selection: "configured", target: "vercel" },
    });

    const parsed = compiledAgentManifestSchema.safeParse(manifest);

    expect(parsed.success).toBe(true);
    expect(manifest.workflowWorld).toEqual({
      kind: "native",
      selection: "configured",
      target: "vercel",
    });
  });
});
