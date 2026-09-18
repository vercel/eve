import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  ParentSessionKey,
  SessionDynamicSubagentSelectionsKey,
  TurnDynamicSubagentSelectionsKey,
} from "#context/keys.js";
import { resolveWorkflowAgentMetadata } from "#execution/tools/subagent/metadata.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

describe("resolveWorkflowAgentMetadata", () => {
  it("includes root self-delegation and hidden static subagents", () => {
    const ctx = context({
      description: "Coordinate specialist work.",
      nodeId: undefined,
      subagentsByName: new Map([
        [
          "researcher",
          {
            definition: {
              description: "Investigate difficult questions.",
              kind: "subagent",
              tool: false,
            },
          },
        ],
      ]),
    });

    expect(resolveWorkflowAgentMetadata(ctx)).toEqual({
      agent: { description: "Coordinate specialist work." },
      researcher: { description: "Investigate difficult questions." },
    });
  });

  it("includes root self-delegation with an empty description when the root has none", () => {
    const ctx = context({ nodeId: undefined, subagentsByName: new Map() });

    expect(resolveWorkflowAgentMetadata(ctx)).toEqual({
      agent: { description: "" },
    });
  });

  it("omits self-delegation from a delegated root copy", () => {
    const ctx = context({
      description: "Coordinate specialist work.",
      nodeId: undefined,
      parentSession: { rootSessionId: "root", sessionId: "parent", turnId: "turn" },
      subagentsByName: new Map(),
    });

    expect(resolveWorkflowAgentMetadata(ctx)).toEqual({});
  });

  it("uses effective dynamic descriptions with turn precedence without adding self-delegation", () => {
    const ctx = context({ nodeId: "subagents/coordinator", subagentsByName: new Map() });
    const prepared = { name: "reviewer" };
    ctx.set(SessionDynamicSubagentSelectionsKey, {
      reviewer: {
        agentConfig: { description: "Review generally." },
        kind: "subagent",
        prepared,
      } as never,
    });
    ctx.set(TurnDynamicSubagentSelectionsKey, {
      reviewer: {
        kind: "remote",
        prepared,
        remoteAgent: { description: "Review this tenant." },
      } as never,
    });

    expect(resolveWorkflowAgentMetadata(ctx)).toEqual({
      reviewer: { description: "Review this tenant." },
    });
  });
});

function context(input: {
  readonly description?: string;
  readonly nodeId: string | undefined;
  readonly parentSession?: unknown;
  readonly subagentsByName: ReadonlyMap<string, unknown>;
}): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(BundleKey, {
    nodeId: input.nodeId,
    resolvedAgent: { config: { description: input.description } },
    subagentRegistry: { subagentsByName: input.subagentsByName },
  } as never);
  if (input.parentSession !== undefined) ctx.set(ParentSessionKey, input.parentSession as never);
  return ctx;
}
