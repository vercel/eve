import { describe, expect, it } from "vitest";

import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import { AGENT_TASK_WORKFLOW_ID, agentTaskCallFromRequest } from "#tasks/agent-tool.js";

function request(input: RuntimeWorkflowTaskRequest["input"]): RuntimeWorkflowTaskRequest {
  return {
    callId: "call-1",
    input,
    kind: "workflow-task",
    toolName: "researcher",
    workflowId: AGENT_TASK_WORKFLOW_ID,
  };
}

describe("agentTaskCallFromRequest", () => {
  it("keeps background on the call and out of the agent's input", () => {
    expect(agentTaskCallFromRequest(request({ background: true, message: "Draft it." }))).toEqual({
      background: true,
      callId: "call-1",
      input: { message: "Draft it.", target: "researcher" },
      toolName: "researcher",
    });
  });

  it.each([false, "true", undefined])("treats background %o as a waited call", (background) => {
    const call = agentTaskCallFromRequest(
      request(background === undefined ? { message: "Draft it." } : { background, message: "x" }),
    );
    expect(call.background).toBeUndefined();
  });
});
