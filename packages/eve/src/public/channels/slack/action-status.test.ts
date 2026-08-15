import { describe, expect, it } from "vitest";

import {
  describeActionRequest,
  describeActionRequests,
} from "#public/channels/slack/action-status.js";
import type { RuntimeActionRequest } from "#runtime/actions/types.js";
import type { JsonObject } from "#shared/json.js";

function toolCall(toolName: string, input: JsonObject = {}): RuntimeActionRequest {
  return { callId: "c1", input, kind: "tool-call", toolName };
}

describe("describeActionRequest", () => {
  it("labels tool calls with the tool name plus the salient argument", () => {
    expect(
      describeActionRequest(toolCall("grep", { path: "packages", pattern: "useEveAgent" })),
    ).toBe("grep useEveAgent");
    expect(describeActionRequest(toolCall("read_file", { filePath: "agent/agent.ts" }))).toBe(
      "read_file agent/agent.ts",
    );
    expect(describeActionRequest(toolCall("bash", { command: "pnpm test\npnpm lint" }))).toBe(
      "bash pnpm test",
    );
  });

  it("keeps the tail of long paths and clips long commands", () => {
    expect(
      describeActionRequest(
        toolCall("read_file", {
          filePath: "/workspace/eve/packages/eve/src/runtime/actions/executor-registry.ts",
        }),
      ),
    ).toBe("read_file actions/executor-registry.ts");

    const clipped = describeActionRequest(toolCall("bash", { command: "x".repeat(120) }));
    expect(clipped.length).toBeLessThanOrEqual("bash ".length + 40);
    expect(clipped.endsWith("...")).toBe(true);
  });

  it("probes generic keys for tools without a salient-key entry", () => {
    expect(describeActionRequest(toolCall("close_issue", { issueNumber: 42 }))).toBe(
      "close_issue 42",
    );
  });

  it("falls back to the bare tool name without a telling argument", () => {
    expect(describeActionRequest(toolCall("list_new_issues"))).toBe("list_new_issues");
  });

  it("labels dispatched calls with the target name and skill loads with the skill", () => {
    expect(
      describeActionRequest({
        callId: "c1",
        description: "Reason about the issue",
        input: {},
        kind: "subagent-call",
        name: "reasoner",
        nodeId: "n1",
        subagentName: "reasoner",
      }),
    ).toBe("reasoner");
    expect(
      describeActionRequest({
        callId: "c1",
        description: "Triage remotely",
        input: {},
        kind: "remote-agent-call",
        name: "triage",
        nodeId: "n1",
        remoteAgentName: "triage",
      }),
    ).toBe("triage");
    expect(
      describeActionRequest({ callId: "c1", input: { skill: "arena" }, kind: "load-skill" }),
    ).toBe("load_skill arena");
  });
});

describe("describeActionRequests", () => {
  it("shows the first label and a count for the rest of the batch", () => {
    expect(
      describeActionRequests([
        toolCall("grep", { pattern: "digest" }),
        toolCall("read_file", { filePath: "a.ts" }),
        toolCall("read_file", { filePath: "b.ts" }),
      ]),
    ).toBe("grep digest +2 more");
  });

  it("returns a generic label for an empty batch", () => {
    expect(describeActionRequests([])).toBe("Working...");
  });
});
