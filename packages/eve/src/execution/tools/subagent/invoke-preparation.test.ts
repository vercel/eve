import { describe, expect, it } from "vitest";

import { planAgentDispatch } from "#execution/tools/subagent/invoke-preparation.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

const localAction = {
  callId: "call-1",
  description: "Research",
  input: { message: "Find it" },
  kind: "subagent-call" as const,
  name: "research",
  nodeId: "subagents/research",
  subagentName: "research",
};

function session(rootSessionId?: string) {
  return {
    agent: { dynamicModel: true as const, system: "", tools: [] },
    compaction: { recentWindowSize: 5, threshold: 10_000 },
    continuationToken: "parent-token",
    history: [],
    rootSessionId,
    sessionId: "parent",
  };
}

describe("planAgentDispatch", () => {
  it.each<{ models: string[] | undefined; execution: JsonObject; agentId: string | undefined }>([
    { models: undefined, execution: { model: "openai/gpt-5.5" }, agentId: undefined },
    { models: ["openai/gpt-5.5"], execution: { model: "other/model" }, agentId: undefined },
    {
      models: ["openai/gpt-5.5"],
      execution: { model: "openai/gpt-5.5", maxCostUsd: -1 },
      agentId: undefined,
    },
    { models: ["openai/gpt-5.5"], execution: { model: "openai/gpt-5.5" }, agentId: "existing" },
  ])(
    "rejects unauthorized or invalid execution settings before dispatch: %j",
    ({ models, execution, agentId }) => {
      const input: Record<string, JsonValue> = { message: "Review", execution };
      if (agentId !== undefined) input.agentId = agentId;
      expect(
        planAgentDispatch({
          action: {
            ...localAction,
            input,
          },
          bundle: {
            subagentRegistry: {
              subagentsByNodeId: new Map([
                [
                  localAction.nodeId,
                  {
                    definition: {
                      kind: "subagent",
                      description: "Review",
                      delegationModels: models,
                    },
                  },
                ],
              ]),
            },
            turnAgent: {},
          } as never,
          ctx: {} as never,
          session: session() as never,
        }),
      ).toMatchObject({ kind: "reject", result: { output: { code: "invalid_execution" } } });
    },
  );

  it("plans a fresh child with authorized execution settings", () => {
    const execution = { model: "openai/gpt-5.5", reasoning: "low", maxCostUsd: 0.2 };
    expect(
      planAgentDispatch({
        action: { ...localAction, input: { message: "Review", execution } },
        bundle: {
          subagentRegistry: {
            subagentsByNodeId: new Map([
              [
                localAction.nodeId,
                {
                  definition: {
                    kind: "subagent",
                    description: "Review",
                    delegationModels: [execution.model],
                  },
                },
              ],
            ]),
          },
          turnAgent: {},
        } as never,
        ctx: {} as never,
        session: session() as never,
      }),
    ).toMatchObject({ kind: "start", target: { action: { input: { execution } } } });
  });
  it("rejects recursive self-agent starts outside the root session", () => {
    expect(
      planAgentDispatch({
        action: { ...localAction, name: "agent", nodeId: "__root__", subagentName: "agent" },
        bundle: {
          subagentRegistry: { subagentsByNodeId: new Map() },
          turnAgent: {},
        } as never,
        ctx: {} as never,
        session: session("root") as never,
      }),
    ).toMatchObject({
      kind: "reject",
      result: { output: { code: "RECURSIVE_AGENT_ROOT_ONLY" } },
    });
  });

  it("rejects a dynamic target omitted from the current selection", () => {
    expect(
      planAgentDispatch({
        action: localAction,
        bundle: {
          subagentRegistry: {
            dynamicNodeIds: new Set([localAction.nodeId]),
            subagentsByNodeId: new Map(),
          },
          turnAgent: {},
        } as never,
        ctx: { get: () => undefined } as never,
        session: session() as never,
      }),
    ).toMatchObject({ kind: "reject", result: { output: { code: "SUBAGENT_UNAVAILABLE" } } });
  });

  it("falls back to a fresh start for an unknown agentId", () => {
    expect(
      planAgentDispatch({
        action: { ...localAction, input: { agentId: "unknown", message: "Find it" } },
        bundle: {
          subagentRegistry: {
            subagentsByNodeId: new Map([
              [localAction.nodeId, { definition: { description: "Research", kind: "subagent" } }],
            ]),
          },
          turnAgent: {},
        } as never,
        ctx: {} as never,
        knownAgentIds: [],
        session: session() as never,
      }),
    ).toMatchObject({ kind: "start", target: { action: localAction, kind: "local" } });
  });
});
