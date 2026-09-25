import { describe, expect, it } from "vitest";

import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import { AGENT_TASK_WORKFLOW_ID, agentTaskCallFromRequest } from "#tasks/agent-tool.js";

function request(
  input: RuntimeWorkflowTaskRequest["input"],
  taskId?: string,
): RuntimeWorkflowTaskRequest {
  const base: RuntimeWorkflowTaskRequest = {
    callId: "call-1",
    input,
    kind: "workflow-task",
    resumable: true,
    toolName: "researcher",
    workflowId: AGENT_TASK_WORKFLOW_ID,
  };
  return taskId === undefined ? base : { ...base, taskId };
}

describe("agentTaskCallFromRequest", () => {
  it("reads the agent's input and send, and names the call after its tool", () => {
    const outputSchema = { type: "object" };
    expect(
      agentTaskCallFromRequest(
        request({ message: "Draft it.", outputSchema }, "researcher-abc234"),
      ),
    ).toEqual({
      callId: "call-1",
      input: {
        message: "Draft it.",
        outputSchema,
        target: "researcher",
        taskId: "researcher-abc234",
      },
      toolName: "researcher",
    });
  });

  it("starts a new agent without a send and drops fields outside the contract", () => {
    expect(agentTaskCallFromRequest(request({ background: true, message: "Draft it." }))).toEqual({
      callId: "call-1",
      input: { message: "Draft it.", target: "researcher" },
      toolName: "researcher",
    });
  });
});
