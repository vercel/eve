import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { ParentSessionKey } from "#context/keys.js";
import { ReactionsStateKey } from "#reactions/state.js";
import { resolveWorkflowAgentMetadata } from "#execution/agent-sessions/metadata.js";
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

  it("uses the descriptions dynamic subagent slots hold without adding self-delegation", () => {
    const ctx = context({ nodeId: "subagents/coordinator", subagentsByName: new Map() });
    ctx.set(ReactionsStateKey, {
      latest: {},
      slots: {
        "subagent:subagents/reviewer": {
          digest: "d",
          since: 1,
          value: {
            kind: "remote",
            prepared: { name: "reviewer" },
            remoteAgent: { description: "Review this tenant." },
          },
        },
      },
    } as never);

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
