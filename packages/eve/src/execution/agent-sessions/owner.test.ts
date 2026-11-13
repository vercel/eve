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

  it("reads an input recorded before held agents as its compiled agent", () => {
    // What a run in flight carries: `bundle` only, with no `agent` field.
    const recorded = JSON.parse('{"bundle":{"source":{"kind":"bundled"}}}') as never;
    expect(ownerReference(recorded)).toEqual({ kind: "bundle", nodeId: undefined, source });
  });

  it("stores a held agent under agent, by its id", () => {
    const owner = agentSessionOwner({ id: "release", kind: "runtime" });
    expect(owner).toEqual({ agent: { id: "release", kind: "runtime" } });
    expect(ownerReference(owner)).toEqual({ id: "release", kind: "runtime" });
  });

  it("passes the recorded owner fields on as they are", () => {
    const bundle = { source };
    const input = { bundle, sessionId: "session-1" };
    expect(ownerFieldsOf(input)).toEqual({ bundle });
    expect(ownerFieldsOf(input).bundle).toBe(bundle);
  });
});
