import { describe, expect, it } from "vitest";

import { compiledAgentManifestSchema, createCompiledAgentManifest } from "#compiler/manifest.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";

describe("compiledAgentManifestSchema", () => {
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
          maxSubagentDepth: 4,
        },
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });

    const parsed = compiledAgentManifestSchema.parse(manifest);

    expect(parsed.config.limits).toEqual({
      maxInputTokensPerSession: 200_000,
      maxOutputTokensPerSession: 20_000,
      maxSubagentDepth: 4,
    });
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
        },
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
      },
    });

    const parsed = compiledAgentManifestSchema.parse(manifest);

    expect(parsed.config.limits).toEqual({
      maxInputTokensPerSession: false,
      maxOutputTokensPerSession: false,
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
