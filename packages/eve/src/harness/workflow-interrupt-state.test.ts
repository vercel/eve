import { describe, expect, it } from "vitest";

import {
  getPendingWorkflowInterrupt,
  isLegacyPendingWorkflowInterrupt,
} from "#harness/workflow-interrupt-state.js";
import { WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND } from "#harness/workflow-runtime-action-state.js";
import type { SessionStateMap } from "#harness/types.js";

describe("pending workflow interrupt state", () => {
  it("recognizes continuations parked by the retired v1 runtime", () => {
    const toolCallId = "workflow-call:tool-1";
    const payload = {
      kind: WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND,
      runtimeAction: {
        kind: "subagent-call",
        nodeId: "subagents/researcher",
        subagentName: "researcher",
      },
      toolInput: { message: "Investigate" },
      toolName: "researcher",
    };
    const state = {
      "eve.harness.pendingWorkflowInterrupt": {
        interrupt: {
          continuation: {
            auth: {
              alg: "HMAC-SHA256",
              expiresAtMs: 2,
              issuedAtMs: 1,
              nonce: "nonce",
              signature: "signature",
            },
            determinism: {
              dateNowMs: 1,
              randomSeed: "00000000000000000000000000000000",
            },
            js: "return tools.researcher({ message: 'Investigate' })",
            ledger: [
              {
                inputJson: JSON.stringify({ message: "Investigate" }),
                interruptId: `${toolCallId}:interrupt`,
                interruptPayload: payload,
                kind: "tool",
                name: "researcher",
                status: "interrupted",
                toolCallId,
              },
            ],
            outerToolCallId: "workflow-call",
            version: 1,
          },
          input: { message: "Investigate" },
          interruptId: `${toolCallId}:interrupt`,
          outerToolCallId: "workflow-call",
          payload,
          toolCallId,
          toolName: "researcher",
          type: "code-mode-interrupt",
        },
        responseMessages: [],
      },
    } as SessionStateMap;

    const pending = getPendingWorkflowInterrupt(state);

    expect(pending).toMatchObject({ usedCalls: 0, version: 1 });
    expect(pending === undefined ? false : isLegacyPendingWorkflowInterrupt(pending)).toBe(true);
  });
});
