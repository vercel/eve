import { describe, expect, it } from "vitest";

import {
  compiledAgentManifestSchema,
  createCompiledAgentManifest,
  createCompiledAgentNodeManifest,
} from "#compiler/manifest.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";

describe("compiledAgentManifestSchema", () => {
  it("requires exactly one static description or dynamic resolver for each subagent", () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });
    const subagent = {
      agent: createCompiledAgentNodeManifest({
        agentRoot: "/app/agent/subagents/research",
        appRoot: "/app",
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
    expect(parses({ dynamic: { eventNames: ["session.started"] } })).toBe(true);
    expect(parses({})).toBe(false);
    expect(
      parses({
        description: "Research requests.",
        dynamic: { eventNames: ["session.started"] },
      }),
    ).toBe(false);
  });

  it("preserves reasoning configuration", () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
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
      agentRoot: "/app/agent",
      appRoot: "/app",
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
      agentRoot: "/app/agent",
      appRoot: "/app",
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
      agentRoot: "/app/agent",
      appRoot: "/app",
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
      agentRoot: "/app/agent",
      appRoot: "/app",
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
      agentRoot: "/app/agent",
      appRoot: "/app",
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
      agentRoot: "/app/agent",
      appRoot: "/app",
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
    });

    const parsed = compiledAgentManifestSchema.parse(manifest);

    expect(parsed.config.dynamicModel).toEqual({
      eventNames: ["session.started"],
      logicalPath: "agent.ts",
      sourceId: "agent-config",
      sourceKind: "module",
    });
  });

  it("preserves uncapped (false) session token limits", () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
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
      agentRoot: "/app/agent",
      appRoot: "/app",
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
