import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import {
  emitWorkflowActionResults,
  emitWorkflowActionsRequested,
} from "#harness/workflow-lifecycle.js";
import { WORKFLOW_TASK_INTERRUPT_KIND } from "#harness/workflow-task-state.js";
import type { HarnessToolMap } from "#harness/types.js";
import { defineState } from "#public/definitions/state.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { WorkflowSandboxInterrupt } from "#shared/workflow-sandbox.js";

const emissionState: HarnessEmissionState = {
  sequence: 2,
  sessionStarted: true,
  stepIndex: 3,
  turnId: "turn_abc",
};

function createTools(): HarnessToolMap {
  return new Map([
    [
      "researcher",
      {
        description: "Delegate to the researcher.",
        inputSchema: jsonSchema({ type: "object" }),
        name: "researcher",
        resultKind: "subagent",
        workflowId: "workflow//./agent/subagents/researcher//execute",
      },
    ],
  ]);
}

function workflowInterrupt(): WorkflowSandboxInterrupt {
  const payload = {
    kind: WORKFLOW_TASK_INTERRUPT_KIND,
    task: {
      resultKind: "subagent" as const,
      workflowId: "workflow//./agent/subagents/researcher//execute",
    },
    toolInput: { message: "Investigate" },
    toolName: "researcher",
  };
  return {
    continuation: {
      auth: {
        alg: "HMAC-SHA256",
        expiresAtMs: 2,
        issuedAtMs: 1,
        nonce: "nonce",
        signature: "signature",
      },
      js: "return tools.researcher({ message: 'Investigate' })",
      outerToolCallId: "outer-call",
      pendingInterruptions: [
        {
          input: { message: "Investigate" },
          interruptId: "outer-call:tool-1:interrupt",
          payload,
          runInterruptionId: "run-interruption-1",
          toolCallId: "outer-call:tool-1",
          toolName: "researcher",
        },
      ],
      resolutions: [],
      token: "token",
      toolNames: ["researcher"],
      version: 2,
    },
    input: { message: "Investigate" },
    interruptId: "outer-call:tool-1:interrupt",
    outerToolCallId: "outer-call",
    payload,
    toolCallId: "outer-call:tool-1",
    toolName: "researcher",
    type: "code-mode-interrupt",
  };
}

describe("workflow lifecycle projection", () => {
  it("emits parked subagent calls and resumed results as action events", async () => {
    const events: UnstampedMessageStreamEvent[] = [];
    const emit = async (event: UnstampedMessageStreamEvent) => {
      events.push(event);
    };

    await emitWorkflowActionsRequested({
      emit,
      emissionState,
      interrupts: [workflowInterrupt()],
      tools: createTools(),
    });
    await emitWorkflowActionResults({
      emit,
      emissionState,
      interrupts: [workflowInterrupt()],
      results: [{ output: { value: "ok" } }],
    });

    expect(events[0]).toMatchObject({
      data: {
        actions: [
          {
            callId: "outer-call:tool-1",
            kind: "tool-call",
            toolName: "researcher",
          },
        ],
        sequence: 2,
        stepIndex: 3,
        turnId: "turn_abc",
      },
      type: "actions.requested",
    });
    expect(events[1]).toMatchObject({
      data: {
        result: {
          callId: "outer-call:tool-1",
          output: { value: "ok" },
          toolName: "researcher",
        },
      },
      type: "action.result",
    });
  });

  it("projects failed child results through the shared result contract", async () => {
    const events: UnstampedMessageStreamEvent[] = [];
    await emitWorkflowActionResults({
      emit: async (event) => {
        events.push(event);
      },
      emissionState,
      interrupts: [workflowInterrupt()],
      results: [{ isError: true, output: "child failed" }],
    });

    expect(events[0]).toMatchObject({
      data: {
        result: { isError: true, output: "child failed" },
        status: "failed",
      },
      type: "action.result",
    });
  });

  it("emits events in the invoking context", async () => {
    const lifecycleDispatches = defineState<string[]>(
      "test.workflow.lifecycle.dispatch-context",
      () => [],
    );
    const buildSession = new ContextContainer();
    const callSession = new ContextContainer();

    await contextStorage.run(callSession, () =>
      emitWorkflowActionsRequested({
        emit: async (event) => {
          lifecycleDispatches.update((events) => [...events, event.type]);
        },
        emissionState,
        interrupts: [workflowInterrupt()],
        tools: createTools(),
      }),
    );

    expect(contextStorage.run(callSession, () => lifecycleDispatches.get())).toEqual([
      "actions.requested",
    ]);
    expect(contextStorage.run(buildSession, () => lifecycleDispatches.get())).toEqual([]);
  });
});
