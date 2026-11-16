import { describe, expect, it } from "vitest";

import {
  agentSessionOwner,
  ownerFieldsOf,
  ownerReference,
} from "#execution/agent-sessions/owner.js";

const source = { kind: "bundled" } as const;

describe("a workflow tool call's owner in its step inputs", () => {
  it("stores a compiled agent under bundle, as step inputs always have", () => {
    expect(
      JSON.stringify(agentSessionOwner({ kind: "bundle", nodeId: "subagents/a", source })),
    ).toBe('{"bundle":{"nodeId":"subagents/a","source":{"kind":"bundled"}}}');
    expect(JSON.stringify(agentSessionOwner({ kind: "bundle", source }))).toBe(
      '{"bundle":{"source":{"kind":"bundled"}}}',
    );
  });

  it("reads a recorded input as its compiled agent", () => {
    // What a run in flight carries: `bundle` only.
    const recorded = JSON.parse('{"bundle":{"source":{"kind":"bundled"}}}') as never;
    expect(ownerReference(recorded)).toEqual({ kind: "bundle", nodeId: undefined, source });
  });

  it("passes the recorded owner fields on as they are", () => {
    const bundle = { source };
    const input = { bundle, sessionId: "session-1" };
    expect(ownerFieldsOf(input)).toEqual({ bundle });
    expect(ownerFieldsOf(input).bundle).toBe(bundle);
  });
});
