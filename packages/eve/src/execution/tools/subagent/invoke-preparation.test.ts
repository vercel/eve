import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  classifyFreshStart,
  resolveAgentInvocationAction,
} from "#execution/tools/subagent/invoke-preparation.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

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

describe("classifyFreshStart", () => {
  it("rejects recursive self-agent starts outside the root session", () => {
    expect(
      classifyFreshStart({
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
      classifyFreshStart({
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

  it("starts a declared local agent with its description", () => {
    expect(
      classifyFreshStart({
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
        session: session() as never,
      }),
    ).toMatchObject({
      kind: "start",
      target: { action: localAction, kind: "local", source: { description: "Research" } },
    });
  });
});

describe("resolveAgentInvocationAction", () => {
  function contextWith(definition: Record<string, unknown>): ContextContainer {
    const ctx = new ContextContainer();
    ctx.set(BundleKey, {
      subagentRegistry: { subagentsByName: new Map([[definition.name, { definition }]]) },
    } as never);
    return ctx;
  }

  it("resolves a declared local agent and keeps the continuation fields", () => {
    const outputSchema = { type: "object" };
    expect(
      resolveAgentInvocationAction({
        ctx: contextWith({
          description: "Research",
          kind: "subagent",
          name: "research",
          nodeId: "subagents/research",
        }),
        input: { agentId: "research-abc234", message: "Find it", outputSchema, target: "research" },
        invocationId: "call-1",
      }),
    ).toEqual({
      callId: "call-1",
      description: "Research",
      input: { agentId: "research-abc234", message: "Find it", outputSchema },
      kind: "subagent-call",
      name: "research",
      nodeId: "subagents/research",
      subagentName: "research",
    });
  });

  it("resolves a remote agent", () => {
    expect(
      resolveAgentInvocationAction({
        ctx: contextWith({ kind: "remote", name: "billing", nodeId: "subagents/billing.ts" }),
        input: { message: "Check the invoice", target: "billing" },
        invocationId: "call-1",
      }),
    ).toMatchObject({ kind: "remote-agent-call", remoteAgentName: "billing" });
  });

  it("fails for a target the agent cannot call", () => {
    expect(() =>
      resolveAgentInvocationAction({
        ctx: contextWith({ kind: "subagent", name: "research", nodeId: "subagents/research" }),
        input: { message: "Find it", target: "missing" },
        invocationId: "call-1",
      }),
    ).toThrow('Agent target "missing" is not available to this agent.');
  });
});
