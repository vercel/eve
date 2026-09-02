import { describe, expect, it } from "vitest";

import {
  buildRuntimeActionsFromWorkflowInterrupt,
  getRuntimeActionKeysFromWorkflowInterrupt,
  getWorkflowRuntimeActionInterrupts,
  WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND,
} from "#harness/workflow-runtime-action-state.js";
import type { WorkflowSandboxInterrupt } from "#shared/workflow-sandbox.js";

function concurrentWorkflowInterrupt(): WorkflowSandboxInterrupt {
  const pendingInterruptions = ["alpha", "beta"].map((message, index) => {
    const toolCallId = `workflow-call:tool-${index + 1}`;
    return {
      input: { message },
      interruptId: `${toolCallId}:interrupt`,
      payload: {
        dispatchTarget: {
          kind: "subagent-call" as const,
          nodeId: "subagents/echo-marker",
          subagentName: "echo-marker",
        },
        kind: WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND,
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

describe("workflow runtime action state", () => {
  it("derives concurrent actions in request order when a later interrupt wins the race", () => {
    const interrupt = concurrentWorkflowInterrupt();

    const pending = getWorkflowRuntimeActionInterrupts(interrupt);
    expect(pending.map((entry) => entry.input)).toEqual([
      { message: "alpha" },
      { message: "beta" },
    ]);
    expect(pending.map((entry) => entry.toolCallId)).toEqual([
      "workflow-call:tool-1",
      "workflow-call:tool-2",
    ]);

    expect(buildRuntimeActionsFromWorkflowInterrupt(interrupt)).toMatchObject([
      {
        callId: "echo-marker_workflow-call_tool-1_interrupt",
        input: { message: "alpha" },
        target: { kind: "subagent-call", subagentName: "echo-marker" },
      },
      {
        callId: "echo-marker_workflow-call_tool-2_interrupt",
        input: { message: "beta" },
        target: { kind: "subagent-call", subagentName: "echo-marker" },
      },
    ]);
    expect(getRuntimeActionKeysFromWorkflowInterrupt(interrupt)).toEqual([
      "subagent-call:echo-marker:echo-marker_workflow-call_tool-1_interrupt",
      "subagent-call:echo-marker:echo-marker_workflow-call_tool-2_interrupt",
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

    expect(getWorkflowRuntimeActionInterrupts(resumed).map((entry) => entry.input)).toEqual([
      { message: "beta" },
    ]);
  });
});
