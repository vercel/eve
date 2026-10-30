import { describe, expect, it } from "vitest";

import { announcedKind, capabilityOf } from "#harness/call-facts.js";
import { SKILL_ENTRY_NAME } from "#protocol/catalog-tools.js";
import { TASK_CANCEL_TOOL_NAME, TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";

describe("what a call invokes", () => {
  it("marks the model's task controls, so readers don't match eve's tool names", () => {
    for (const toolName of [TASK_WAIT_TOOL_NAME, TASK_CANCEL_TOOL_NAME]) {
      expect(capabilityOf({ callId: "c", input: {}, kind: "tool-call", toolName })).toEqual({
        kind: "control",
        name: toolName,
      });
      expect(announcedKind(toolName, undefined)).toBe("control");
    }
    expect(capabilityOf({ callId: "c", input: {}, kind: "tool-call", toolName: "deploy" })).toEqual(
      { kind: "tool", name: "deploy" },
    );
  });

  it("marks an agent another deployment serves as remote", () => {
    const common = {
      callId: "c",
      description: "Research",
      input: { message: "hi" },
      name: "research",
      nodeId: "n",
    };
    expect(
      capabilityOf({ ...common, kind: "remote-agent-call", remoteAgentName: "research" }),
    ).toEqual({ kind: "agent", name: "research", remote: true });
    expect(capabilityOf({ ...common, kind: "subagent-call", subagentName: "research" })).toEqual({
      kind: "agent",
      name: "research",
    });
  });

  it("announces the kind a call's row will name", () => {
    expect(announcedKind("deploy", undefined)).toBe("tool");
    expect(announcedKind(SKILL_ENTRY_NAME, undefined)).toBe("skill");
    expect(
      announcedKind("researcher", {
        behavior: {
          availability: [],
          handling: {
            kind: "dispatch",
            target: { kind: "subagent-call", nodeId: "subagents/researcher", subagentName: "r" },
          },
        },
      }),
    ).toBe("agent");
  });
});
