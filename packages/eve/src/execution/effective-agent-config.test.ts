import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { AgentSessionRuntimeOverridesKey, DynamicSubagentAgentConfigKey } from "#context/keys.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";

describe("resolveEffectiveAgentRuntime", () => {
  it("applies the selected subagent model and runtime settings", () => {
    const ctx = new ContextContainer();
    ctx.set(DynamicSubagentAgentConfigKey, {
      description: "Perform deep research.",
      limits: { sessionTimeoutMs: 120_000 },
      model: { id: "anthropic/claude-opus-4.6" },
      reasoning: "high",
    });
    const tools = [{ name: "search" }];

    const effective = resolveEffectiveAgentRuntime(
      {
        resolvedAgent: {
          config: {
            limits: { sessionTimeoutMs: 60_000 },
          },
        },
        turnAgent: {
          id: "researcher",
          instructions: ["Research carefully."],
          model: { id: "openai/gpt-5.5" },
          tools,
          workspaceSpec: {} as never,
        },
      } as never,
      ctx,
    );

    expect(effective).toMatchObject({
      limits: { sessionTimeoutMs: 120_000 },
      turnAgent: {
        model: { id: "anthropic/claude-opus-4.6" },
        reasoning: "high",
      },
    });
    expect(effective.turnAgent.instructions).toEqual(["Research carefully."]);
    expect(effective.turnAgent.tools).toBe(tools);
  });

  it("overrides only the selected agent model for a ctx.agent session", () => {
    const ctx = new ContextContainer();
    ctx.set(DynamicSubagentAgentConfigKey, {
      description: "Perform deep research.",
      limits: { sessionTimeoutMs: 120_000 },
      model: { id: "anthropic/claude-opus-4.6" },
      reasoning: "high",
    });
    ctx.set(AgentSessionRuntimeOverridesKey, {
      model: { id: "openai/gpt-5.5", reasoning: "low" },
    });

    const effective = resolveEffectiveAgentRuntime(
      {
        resolvedAgent: { config: {} },
        turnAgent: {
          configResolver: true,
          id: "researcher",
          instructions: ["Research carefully."],
          tools: [{ name: "search" }],
          workspaceSpec: {} as never,
        },
      } as never,
      ctx,
    );

    expect(effective).toMatchObject({
      limits: { sessionTimeoutMs: 120_000 },
      turnAgent: {
        instructions: ["Research carefully."],
        model: { id: "openai/gpt-5.5", reasoning: "low" },
        reasoning: "high",
        tools: [{ name: "search" }],
      },
    });
    expect(effective.turnAgent).not.toHaveProperty("configResolver");
    expect(effective.turnAgent).not.toHaveProperty("dynamicModel");
  });

  it("takes precedence over an authored dynamic model", () => {
    const ctx = new ContextContainer();
    ctx.set(AgentSessionRuntimeOverridesKey, {
      model: { id: "anthropic/claude-opus-5.5" },
    });

    const effective = resolveEffectiveAgentRuntime(
      {
        resolvedAgent: { config: {} },
        turnAgent: {
          dynamicModel: {
            eventNames: ["turn.started"],
            logicalPath: "agent/agent.ts",
            sourceId: "agent-config",
          },
          id: "root",
          instructions: ["Help the user."],
          tools: [{ name: "search" }],
          workspaceSpec: {} as never,
        },
      } as never,
      ctx,
    );

    expect(effective.turnAgent).toMatchObject({
      id: "root",
      instructions: ["Help the user."],
      model: { id: "anthropic/claude-opus-5.5" },
      tools: [{ name: "search" }],
    });
    expect(effective.turnAgent).not.toHaveProperty("dynamicModel");
  });
});
