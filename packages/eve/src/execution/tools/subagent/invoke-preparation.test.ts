import { describe, expect, it } from "vitest";

import { planAgentDispatch } from "#execution/tools/subagent/invoke-preparation.js";

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

  describe("model choices", () => {
    const bundle = (modelChoices?: readonly string[]) =>
      ({
        subagentRegistry: {
          subagentsByNodeId: new Map([
            [
              localAction.nodeId,
              {
                definition: {
                  description: "Research",
                  kind: "subagent",
                  modelChoices: modelChoices?.map((id) => ({ id })),
                },
              },
            ],
          ]),
        },
        turnAgent: {},
      }) as never;
    const plan = (input: Record<string, string>, modelChoices?: readonly string[]) =>
      planAgentDispatch({
        action: { ...localAction, input: { message: "Find it", ...input } },
        bundle: bundle(modelChoices),
        ctx: {} as never,
        knownAgentIds: ["known"],
        session: session() as never,
      });

    it("starts a new agent with a listed model", () => {
      expect(
        plan({ model: "openai/gpt-5.5" }, ["anthropic/claude-sonnet-5", "openai/gpt-5.5"]),
      ).toMatchObject({
        kind: "start",
        target: { action: { input: { model: "openai/gpt-5.5" } }, kind: "local" },
      });
    });

    it("rejects an unlisted model", () => {
      expect(plan({ model: "openai/gpt-5.5" }, ["anthropic/claude-sonnet-5"])).toMatchObject({
        kind: "reject",
        result: {
          output: {
            code: "SUBAGENT_MODEL_INVALID",
            message: 'Subagent "research" accepts one of these models: anthropic/claude-sonnet-5.',
          },
        },
      });
    });

    it("rejects a model for a subagent without model choices", () => {
      expect(plan({ model: "openai/gpt-5.5" })).toMatchObject({
        kind: "reject",
        result: { output: { code: "SUBAGENT_MODEL_INVALID" } },
      });
    });

    it("rejects a model when continuing an existing agent", () => {
      expect(
        plan({ agentId: "known", model: "openai/gpt-5.5" }, [
          "anthropic/claude-sonnet-5",
          "openai/gpt-5.5",
        ]),
      ).toMatchObject({ kind: "reject", result: { output: { code: "SUBAGENT_MODEL_INVALID" } } });
    });
  });
});
