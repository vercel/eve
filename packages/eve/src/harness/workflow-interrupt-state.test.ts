import { describe, expect, it } from "vitest";

import { getPendingWorkflowInterrupt } from "#harness/workflow-interrupt-state.js";
import { WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND } from "#harness/workflow-runtime-action-state.js";
import type { SessionStateMap } from "#harness/types.js";

describe("pending workflow interrupt state", () => {
  it("reads the persisted call budget with an official runtime continuation", () => {
    const state = {
      "eve.harness.pendingWorkflowInterrupt": {
        interrupt: {
          continuation: {
            outerToolCallId: "workflow-call",
            pendingInterruptions: [],
            resolutions: [],
            version: 2,
          },
          interruptId: "workflow-call:tool-1:interrupt",
          outerToolCallId: "workflow-call",
          payload: { kind: WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND },
          type: "code-mode-interrupt",
        },
        responseMessages: [],
        usedCalls: 3,
      },
    } as SessionStateMap;

    expect(getPendingWorkflowInterrupt(state)).toMatchObject({ usedCalls: 3 });
  });

  it("rejects pending state without a valid persisted call budget", () => {
    const state = {
      "eve.harness.pendingWorkflowInterrupt": {
        interrupt: {
          continuation: {
            outerToolCallId: "workflow-call",
            pendingInterruptions: [],
            resolutions: [],
            version: 2,
          },
          interruptId: "workflow-call:tool-1:interrupt",
          outerToolCallId: "workflow-call",
          payload: { kind: WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND },
          type: "code-mode-interrupt",
        },
        responseMessages: [],
      },
    } as SessionStateMap;

    expect(getPendingWorkflowInterrupt(state)).toBeUndefined();
  });
});
