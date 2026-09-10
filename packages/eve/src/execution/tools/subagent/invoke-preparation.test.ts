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

  it("preloads history only on a fresh local start", () => {
    const history = [{ content: "Prior context", role: "user" as const }];
    expect(
      planAgentDispatch({
        action: localAction,
        bundle: {
          subagentRegistry: {
            subagentsByNodeId: new Map([
              [localAction.nodeId, { definition: { description: "Research", kind: "subagent" } }],
            ]),
          },
          turnAgent: {},
        } as never,
        ctx: {} as never,
        parentHistory: history,
        session: session() as never,
      }),
    ).toMatchObject({ kind: "start", target: { parentHistory: history, kind: "local" } });
  });

  it.each([["agent-1"], ["unknown"]] as const)(
    "rejects inherited history with agent id %s",
    (agentId) => {
      expect(() =>
        planAgentDispatch({
          action: { ...localAction, input: { agentId, message: "Find it" } },
          bundle: { subagentRegistry: { subagentsByNodeId: new Map() }, turnAgent: {} } as never,
          ctx: {} as never,
          parentHistory: [{ content: "Prior context", role: "user" }],
          knownAgentIds: ["agent-1"],
          session: session() as never,
        }),
      ).toThrow("cannot combine `agentId` with inherited history");
    },
  );

  it("rejects inherited history for a remote agent", () => {
    expect(() =>
      planAgentDispatch({
        action: { ...localAction, kind: "remote-agent-call", remoteAgentName: "research" },
        bundle: { subagentRegistry: { subagentsByNodeId: new Map() }, turnAgent: {} } as never,
        ctx: {} as never,
        parentHistory: [{ content: "Prior context", role: "user" }],
        session: session() as never,
      }),
    ).toThrow("can inherit history only when creating a local subagent");
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
