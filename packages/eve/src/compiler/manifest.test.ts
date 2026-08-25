import { describe, expect, it } from "vitest";

import {
  COMPILED_AGENT_MANIFEST_VERSION,
  compiledAgentManifestSchema,
  createCompiledAgentResources,
  createCompiledAgentManifest,
  createCompiledAgentNodeManifest,
  type CreateCompiledAgentResourcesInput,
} from "#compiler/manifest.js";
import {
  EMPTY_CHANNEL_ROUTE_PLAN,
  EMPTY_SOURCE_COMPOSITION,
  testCompiledSandbox,
} from "#internal/testing/compiled-node-fixtures.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";

function baseNodeInput(agentRoot: string, appRoot: string): CreateCompiledAgentResourcesInput {
  return {
    agentRoot,
    appRoot,
    bindings: {},
    sandbox: testCompiledSandbox(),
    sourceComposition: EMPTY_SOURCE_COMPOSITION,
  };
}

function baseManifestInput(agentRoot = "/app/agent", appRoot = "/app") {
  return {
    ...baseNodeInput(agentRoot, appRoot),
    channelRoutes: EMPTY_CHANNEL_ROUTE_PLAN,
  };
}

describe("compiledAgentManifestSchema", () => {
  it("round-trips the current manifest version with required node fields", () => {
    const manifest = createCompiledAgentManifest({
      ...baseManifestInput(),
      bindings: {
        "tools/echo.ts": {
          backing: {
            externalDependencies: [],
            kind: "filesystem",
            sourcePath: "/app/agent/tools/echo.ts",
          },
          logicalPath: "tools/echo.ts",
          owner: { kind: "application" },
        },
      },
      config: {
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });

    const parsed = compiledAgentManifestSchema.parse(manifest);

    expect(parsed.version).toBe(COMPILED_AGENT_MANIFEST_VERSION);
    expect(parsed.bindings["tools/echo.ts"]).toEqual({
      backing: {
        externalDependencies: [],
        kind: "filesystem",
        sourcePath: "/app/agent/tools/echo.ts",
      },
      logicalPath: "tools/echo.ts",
      owner: { kind: "application" },
    });
    expect(parsed.sandbox).toEqual(testCompiledSandbox());
    expect(parsed.sourceComposition).toEqual(EMPTY_SOURCE_COMPOSITION);
    expect(parsed.channelRoutes).toEqual(EMPTY_CHANNEL_ROUTE_PLAN);
  });

  it("rejects manifests missing the required composition fields", () => {
    const manifest = createCompiledAgentManifest({
      ...baseManifestInput(),
      config: {
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });

    const withoutChannelRoutes = { ...manifest } as Record<string, unknown>;
    delete withoutChannelRoutes.channelRoutes;
    expect(compiledAgentManifestSchema.safeParse(withoutChannelRoutes).success).toBe(false);

    const withoutBindings = { ...manifest } as Record<string, unknown>;
    delete withoutBindings.bindings;
    expect(compiledAgentManifestSchema.safeParse(withoutBindings).success).toBe(false);

    const withoutComposition = { ...manifest } as Record<string, unknown>;
    delete withoutComposition.sourceComposition;
    expect(compiledAgentManifestSchema.safeParse(withoutComposition).success).toBe(false);

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
      ...baseManifestInput(),
      channels: [
        { ...channel, method: "HEAD" },
        { ...channel, method: "OPTIONS" },
      ],
      config: {
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });

    const parsed = compiledAgentManifestSchema.parse(manifest);
    expect(
      parsed.channels.map((entry) => (entry.kind === "channel" ? entry.method : null)),
    ).toEqual(["HEAD", "OPTIONS"]);
  });

  it("requires exactly one static description or dynamic resolver for each subagent", () => {
    const manifest = createCompiledAgentManifest({
      ...baseManifestInput(),
      config: {
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });
    const subagent = {
      agent: createCompiledAgentNodeManifest({
        ...baseNodeInput("/app/agent/subagents/research", "/app"),
        config: {
          model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
          name: "research",
        },
      }),
      entryPath: "subagents/research/agent.ts",
      logicalPath: "subagents/research",
      name: "research",
      nodeId: "research",
      rootPath: "/app/agent/subagents/research",
      sourceId: "subagents/research/agent.ts",
      sourceKind: "module",
    } as const;
    const parses = (variant: Readonly<Record<string, unknown>>): boolean =>
      compiledAgentManifestSchema.safeParse({
        ...manifest,
        subagents: [{ ...subagent, ...variant }],
      }).success;

    expect(parses({ description: "Research requests." })).toBe(true);
    expect(
      parses({
        agent: createCompiledAgentResources(baseNodeInput("/app/agent/subagents/research", "/app")),
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
      ...baseManifestInput(),
      config: {
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
      ...baseManifestInput(),
      config: {
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
      ...baseManifestInput(),
      config: {
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
      ...baseManifestInput(),
      config: {
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
      ...baseManifestInput(),
      config: {
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
      workflowTool: { maxSubagents: 6 },
    });

    const parsed = compiledAgentManifestSchema.parse(manifest);

    expect(parsed.workflowTool).toEqual({ maxSubagents: 6 });
  });

  it("preserves web search provider configuration", () => {
    const manifest = createCompiledAgentManifest({
      ...baseManifestInput(),
      config: {
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
      webSearchProvider: "exa",
    });

    const parsed = compiledAgentManifestSchema.parse(manifest);

    expect(parsed.webSearchProvider).toBe("exa");
  });

  it("preserves dynamic model resolver source", () => {
    const manifest = createCompiledAgentManifest({
      ...baseManifestInput(),
      config: {
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
          ...baseManifestInput(),
          config: {
            model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
            name: "app",
          },
        }),
        config: {
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
      ...baseManifestInput(),
      config: {
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

  it("accepts compiled workflow world configuration", () => {
    const manifest = createCompiledAgentManifest({
      ...baseManifestInput(),
      config: {
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
        experimental: {
          workflow: {
            world: "@acme/eve-world",
          },
        },
      },
    });

    const parsed = compiledAgentManifestSchema.safeParse(manifest);

    expect(parsed.success).toBe(true);
    expect(manifest.config.experimental?.workflow).toEqual({ world: "@acme/eve-world" });
  });
});
