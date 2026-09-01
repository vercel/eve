import { describe, expect, it } from "vitest";

import {
  buildWorkflowTasksFromInterrupt,
  getWorkflowTaskCallIds,
  getWorkflowTaskInterrupts,
  WORKFLOW_TASK_INTERRUPT_KIND,
} from "#harness/workflow-task-state.js";
import type { WorkflowSandboxInterrupt } from "#shared/workflow-sandbox.js";

function concurrentWorkflowInterrupt(): WorkflowSandboxInterrupt {
  const pendingInterruptions = ["alpha", "beta"].map((message, index) => {
    const toolCallId = `workflow-call:tool-${index + 1}`;
    return {
      input: { message },
      interruptId: `${toolCallId}:interrupt`,
      payload: {
        kind: WORKFLOW_TASK_INTERRUPT_KIND,
        task: {
          resultKind: "subagent",
          workflowId: "workflow//eve//subagentToolExecuteWorkflow",
        },
        toolInput: { message },
        toolName: "echo-marker",
      },
      runInterruptionId: `run-interruption-${index + 1}`,
      toolCallId,
      toolName: "echo-marker",
    };
  });
  const continuation = {
    auth: {
      alg: "HMAC-SHA256" as const,
      expiresAtMs: 2,
      issuedAtMs: 1,
      nonce: "nonce",
      signature: "signature",
    },
    js: "return Promise.all([])",
    outerToolCallId: "workflow-call",
    pendingInterruptions,
    resolutions: [],
    token: "token",
    toolNames: ["echo-marker"],
    version: 2 as const,
  };
  const returned = pendingInterruptions[1]!;

  return {
    continuation,
    input: { message: "beta" },
    interruptId: returned.interruptId,
    outerToolCallId: continuation.outerToolCallId,
    payload: returned.payload,
    toolCallId: returned.toolCallId,
    toolName: returned.toolName,
    type: "code-mode-interrupt",
  };
}

describe("workflow task state", () => {
  it("derives concurrent tasks in request order when a later interrupt wins the race", () => {
    const interrupt = concurrentWorkflowInterrupt();

    const pending = getWorkflowTaskInterrupts(interrupt);
    expect(pending.map((entry) => entry.input)).toEqual([
      { message: "alpha" },
      { message: "beta" },
    ]);
    expect(pending.map((entry) => entry.toolCallId)).toEqual([
      "workflow-call:tool-1",
      "workflow-call:tool-2",
    ]);

    expect(buildWorkflowTasksFromInterrupt(interrupt)).toMatchObject([
      {
        callId: "echo-marker_workflow-call_tool-1_interrupt",
        input: { message: "alpha" },
        kind: "workflow-task",
        resultKind: "subagent",
        toolName: "echo-marker",
      },
      {
        callId: "echo-marker_workflow-call_tool-2_interrupt",
        input: { message: "beta" },
        kind: "workflow-task",
        resultKind: "subagent",
        toolName: "echo-marker",
      },
    ]);
    expect(getWorkflowTaskCallIds(interrupt)).toEqual([
      "echo-marker_workflow-call_tool-1_interrupt",
      "echo-marker_workflow-call_tool-2_interrupt",
    ]);
  });

  it("excludes interruptions already resolved in the current continuation batch", () => {
    const interrupt = concurrentWorkflowInterrupt();
    const resumed = {
      ...interrupt,
      continuation: {
        ...interrupt.continuation,
        resolutions: [{ runInterruptionId: "run-interruption-1", value: "alpha-result" }],
      },
      input: { message: "beta" },
      interruptId: "workflow-call:tool-2:interrupt",
      toolCallId: "workflow-call:tool-2",
    };

    expect(getWorkflowTaskInterrupts(resumed).map((entry) => entry.input)).toEqual([
      { message: "beta" },
    ]);
  });
});
