import { describe, expect, it } from "vitest";

import { WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND } from "#harness/workflow-runtime-action-state.js";
import {
  countResolvedWorkflowSubagentCalls,
  DEFAULT_WORKFLOW_MAX_SUBAGENTS,
  planWorkflowSubagentDispatch,
} from "#harness/workflow-subagent-limit.js";
import type { RuntimeActionRequest } from "#runtime/actions/types.js";
import type { WorkflowSandboxInterrupt } from "#shared/workflow-sandbox.js";

type LedgerEntry = WorkflowSandboxInterrupt["continuation"]["ledger"][number];

function fulfilledEntry(index: number): LedgerEntry {
  return {
    dateNowMs: 1,
    inputJson: JSON.stringify({ message: `done-${index}` }),
    kind: "tool",
    name: "echo-marker",
    status: "fulfilled",
    toolCallId: `workflow-call:tool-${index}`,
    valueJson: JSON.stringify({ output: "ok" }),
  };
}

function interruptedEntry(index: number): LedgerEntry {
  const toolCallId = `workflow-call:tool-${index}`;
  return {
    inputJson: JSON.stringify({ message: `pending-${index}` }),
    interruptId: `${toolCallId}:interrupt`,
    interruptPayload: {
      kind: WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND,
      runtimeAction: {
        kind: "subagent-call",
        nodeId: "subagents/echo-marker",
        subagentName: "echo-marker",
      },
      toolInput: { message: `pending-${index}` },
      toolName: "echo-marker",
    },
    kind: "tool",
    name: "echo-marker",
    status: "interrupted",
    toolCallId,
  };
}

function createInterrupt(ledger: LedgerEntry[]): WorkflowSandboxInterrupt {
  return {
    continuation: {
      auth: {
        alg: "HMAC-SHA256",
        expiresAtMs: 2,
        issuedAtMs: 1,
        nonce: "nonce",
        signature: "signature",
      },
      determinism: { dateNowMs: 1, randomSeed: "00000000000000000000000000000000" },
      js: "return 1",
      ledger,
      outerToolCallId: "workflow-call",
      version: 1,
    },
    input: {},
    interruptId: "workflow-call:tool-1:interrupt",
    outerToolCallId: "workflow-call",
    payload: { kind: WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND },
    toolCallId: "workflow-call:tool-1",
    toolName: "echo-marker",
    type: "code-mode-interrupt",
  };
}

function createAction(index: number): RuntimeActionRequest {
  return {
    callId: `call-${index}`,
    description: "",
    input: {},
    kind: "subagent-call",
    name: "echo-marker",
    nodeId: "subagents/echo-marker",
    subagentName: "echo-marker",
  };
}

describe("countResolvedWorkflowSubagentCalls", () => {
  it("counts fulfilled and rejected tool entries but not pending interrupts", () => {
    const interrupt = createInterrupt([
      fulfilledEntry(1),
      {
        dateNowMs: 1,
        error: { message: "boom", name: "Error" },
        inputJson: "{}",
        kind: "tool",
        name: "echo-marker",
        status: "rejected",
        toolCallId: "workflow-call:tool-2",
      },
      interruptedEntry(3),
    ]);

    expect(countResolvedWorkflowSubagentCalls(interrupt)).toBe(2);
  });
});

describe("planWorkflowSubagentDispatch", () => {
  it("allows every pending action while the budget holds", () => {
    const actions = [createAction(1), createAction(2)];
    const plan = planWorkflowSubagentDispatch({
      actions,
      interrupt: createInterrupt([interruptedEntry(1), interruptedEntry(2)]),
      maxSubagents: 3,
    });

    expect(plan.allowed).toEqual(actions);
    expect(plan.blocked).toEqual([]);
    expect(plan.usedCalls).toBe(0);
  });

  it("blocks the actions beyond the remaining budget, preserving ledger order", () => {
    const actions = [createAction(1), createAction(2), createAction(3)];
    const plan = planWorkflowSubagentDispatch({
      actions,
      interrupt: createInterrupt([
        fulfilledEntry(0),
        ...actions.map((_, i) => interruptedEntry(i + 1)),
      ]),
      maxSubagents: 3,
    });

    expect(plan.allowed).toEqual([actions[0], actions[1]]);
    expect(plan.blocked).toEqual([actions[2]]);
    expect(plan.usedCalls).toBe(1);
  });

  it("blocks everything once the budget is spent", () => {
    const plan = planWorkflowSubagentDispatch({
      actions: [createAction(1)],
      interrupt: createInterrupt([fulfilledEntry(1), fulfilledEntry(2), interruptedEntry(3)]),
      maxSubagents: 2,
    });

    expect(plan.allowed).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
  });

  it("defaults the budget to DEFAULT_WORKFLOW_MAX_SUBAGENTS", () => {
    const plan = planWorkflowSubagentDispatch({
      actions: [createAction(1)],
      interrupt: createInterrupt([interruptedEntry(1)]),
    });

    expect(plan.maxSubagents).toBe(DEFAULT_WORKFLOW_MAX_SUBAGENTS);
  });
});
