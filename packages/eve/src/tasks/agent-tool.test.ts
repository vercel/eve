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
  it("reads the agent's input and names the call after its tool", () => {
    const outputSchema = { type: "object" };
    expect(
      agentTaskCallFromRequest(
        request({ agentId: "researcher-abc234", message: "Draft it.", outputSchema }),
      ),
    ).toEqual({
      callId: "call-1",
      input: {
        agentId: "researcher-abc234",
        message: "Draft it.",
        outputSchema,
        target: "researcher",
      },
      toolName: "researcher",
    });
  });

  it("starts a new agent for a blank agentId and drops fields outside the contract", () => {
    expect(
      agentTaskCallFromRequest(request({ agentId: " ", background: true, message: "Draft it." })),
    ).toEqual({
      callId: "call-1",
      input: { message: "Draft it.", target: "researcher" },
      toolName: "researcher",
    });
  });
});
