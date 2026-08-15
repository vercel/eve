import { describe, expect, it } from "vitest";

import {
  buildRuntimeActionsFromWorkflowInterrupt,
  getRuntimeActionKeysFromWorkflowInterrupt,
  getWorkflowRuntimeActionInterrupts,
  WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND,
} from "#harness/workflow-runtime-action-state.js";
import type { WorkflowSandboxInterrupt } from "#shared/workflow-sandbox.js";

function concurrentWorkflowInterrupt(): WorkflowSandboxInterrupt {
  const continuation = {
    auth: {
      alg: "HMAC-SHA256" as const,
      expiresAtMs: 2,
      issuedAtMs: 1,
      nonce: "nonce",
      signature: "signature",
    },
    determinism: {
      dateNowMs: 1,
      randomSeed: "00000000000000000000000000000000",
    },
    js: "return Promise.all([])",
    ledger: ["alpha", "beta"].map((message, index) => {
      const toolCallId = `workflow-call:tool-${index + 1}`;
      return {
        inputJson: JSON.stringify({ message }),
        interruptId: `${toolCallId}:interrupt`,
        interruptPayload: {
          kind: WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND,
          runtimeAction: {
            kind: "subagent-call" as const,
            nodeId: "subagents/echo-marker",
            subagentName: "echo-marker",
          },
          toolInput: { message },
          toolName: "echo-marker",
        },
        kind: "tool" as const,
        name: "echo-marker",
        status: "interrupted" as const,
        toolCallId,
      };
    }),
    outerToolCallId: "workflow-call",
    version: 1 as const,
  };
  const returned = continuation.ledger[1]!;

  return {
    continuation,
    input: { message: "beta" },
    interruptId: returned.interruptId,
    outerToolCallId: continuation.outerToolCallId,
    payload: returned.interruptPayload,
    toolCallId: returned.toolCallId,
    toolName: returned.name,
    type: "code-mode-interrupt",
  };
}

describe("workflow runtime action state", () => {
  it("derives concurrent actions in ledger order when a later interrupt wins the race", () => {
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
        kind: "subagent-call",
        subagentName: "echo-marker",
      },
      {
        callId: "echo-marker_workflow-call_tool-2_interrupt",
        input: { message: "beta" },
        kind: "subagent-call",
        subagentName: "echo-marker",
      },
    ]);
    expect(getRuntimeActionKeysFromWorkflowInterrupt(interrupt)).toEqual([
      "subagent-call:echo-marker:echo-marker_workflow-call_tool-1_interrupt",
      "subagent-call:echo-marker:echo-marker_workflow-call_tool-2_interrupt",
    ]);
  });
});
