import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { DynamicSubagentAgentConfigKey } from "#context/keys.js";
import { agentLimits, agentSettings } from "#execution/effective-agent-config.js";
import { fromCompiledBundle } from "#definitions/compiled-agent.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";

const bundle = {
  resolvedAgent: {
    config: { compaction: { thresholdPercent: 0.9 }, limits: { sessionTimeoutMs: 60_000 } },
  },
  turnAgent: {
    compactionModel: { id: "openai/gpt-5.4-mini" },
    id: "researcher",
    model: { id: "openai/gpt-5.5" },
    reasoning: "low",
    tools: [],
    workspaceSpec: {},
  },
} as never;

describe("the agent's settings", () => {
  it("are agent.ts's", () => {
    const ctx = new ContextContainer();
    ctx.set(SessionAgentKey, fromCompiledBundle(bundle));

    expect(agentSettings({ ctx })).toEqual({
      compactionModel: { id: "openai/gpt-5.4-mini" },
      reasoning: "low",
      thresholdPercent: 0.9,
    });
    expect(agentLimits(fromCompiledBundle(bundle), ctx)?.sessionTimeoutMs).toBe(60_000);
  });

  it("are a dynamic subagent config's, in its session", () => {
    const ctx = new ContextContainer();
    ctx.set(SessionAgentKey, fromCompiledBundle(bundle));
    ctx.set(DynamicSubagentAgentConfigKey, {
      compaction: { model: { id: "anthropic/claude-sonnet-4.5" }, thresholdPercent: 0.75 },
      description: "Perform deep research.",
      limits: { sessionTimeoutMs: 120_000 },
      model: { id: "anthropic/claude-opus-4.6" },
      reasoning: "high",
    });

    expect(agentSettings({ ctx })).toEqual({
      compactionModel: { id: "anthropic/claude-sonnet-4.5" },
      reasoning: "high",
      thresholdPercent: 0.75,
    });
    expect(agentLimits(fromCompiledBundle(bundle), ctx)).toEqual({ sessionTimeoutMs: 120_000 });
  });
});
