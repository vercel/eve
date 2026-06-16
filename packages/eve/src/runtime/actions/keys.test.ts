import { describe, expect, it } from "vitest";

import { getRuntimeActionRequestKey, getRuntimeActionResultKey } from "#runtime/actions/keys.js";

describe("runtime action keys", () => {
  it("pairs load-skill requests and results", () => {
    expect(getRuntimeActionRequestKey({ callId: "call_1", input: {}, kind: "load-skill" })).toBe(
      "runtime-action:load-skill:call_1",
    );
    expect(
      getRuntimeActionResultKey({ callId: "call_1", kind: "load-skill-result", output: null }),
    ).toBe("runtime-action:load-skill:call_1");
  });

  it("pairs subagent requests and results", () => {
    expect(
      getRuntimeActionRequestKey({
        callId: "call_2",
        description: "check",
        input: {},
        kind: "subagent-call",
        name: "reviewer",
        nodeId: "node_1",
        subagentName: "reviewer",
      }),
    ).toBe("subagent-call:reviewer:call_2");
    expect(
      getRuntimeActionResultKey({
        callId: "call_2",
        kind: "subagent-result",
        output: "done",
        subagentName: "reviewer",
      }),
    ).toBe("subagent-call:reviewer:call_2");
  });

  it("pairs tool requests and results", () => {
    expect(
      getRuntimeActionRequestKey({
        callId: "call_3",
        input: {},
        kind: "tool-call",
        toolName: "shell",
      }),
    ).toBe("tool-call:shell:call_3");
    expect(
      getRuntimeActionResultKey({
        callId: "call_3",
        kind: "tool-result",
        output: 42,
        toolName: "shell",
      }),
    ).toBe("tool-call:shell:call_3");
  });
});
