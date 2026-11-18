import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { ParentSessionKey } from "#context/keys.js";
import { DefinitionsStateKey } from "#definitions/state.js";
import { fromCompiledBundle } from "#definitions/compiled-agent.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";

describe("a compiled agent's delegates", () => {
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

    expect(delegatesOf(ctx)).toEqual({
      agent: { description: "Coordinate specialist work." },
      researcher: { description: "Investigate difficult questions." },
    });
  });

  it("includes root self-delegation with an empty description when the root has none", () => {
    const ctx = context({ nodeId: undefined, subagentsByName: new Map() });

    expect(delegatesOf(ctx)).toEqual({
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

    expect(delegatesOf(ctx)).toEqual({});
  });

  it("uses the descriptions dynamic subagent slots hold without adding self-delegation", () => {
    const ctx = context({ nodeId: "subagents/coordinator", subagentsByName: new Map() });
    ctx.set(DefinitionsStateKey, {
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

    expect(delegatesOf(ctx)).toEqual({
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
  ctx.set(
    SessionAgentKey,
    fromCompiledBundle({
      nodeId: input.nodeId,
      resolvedAgent: { config: { description: input.description } },
      subagentRegistry: { subagentsByName: input.subagentsByName },
    } as never),
  );
  if (input.parentSession !== undefined) ctx.set(ParentSessionKey, input.parentSession as never);
  return ctx;
}

function delegatesOf(ctx: ContextContainer) {
  return ctx.require(SessionAgentKey).delegates(ctx);
}
