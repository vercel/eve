import { beforeEach, expect, it, vi } from "vitest";

import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { createBlockingWorkflow } from "#execution/tools/workflow/workflow-owner-blocking.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }),
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({ resumeHookStep: vi.fn() }));

const from = {
  callId: "call-1",
  generation: 1,
  input: {},
  runId: "run-1",
  sequence: 0,
  stepIndex: 0,
  taskId: "deploy-abc234",
  toolName: "deploy",
  turnId: "turn-1",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resumeHookStep).mockResolvedValue(true);
});

function owner() {
  return createBlockingWorkflow({
    callId: "call-1",
    hookToken: "run-1:command",
    input: {},
    owner: { inbox: "owner-inbox" },
    session: {
      auth: { current: null, initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    stepIndex: 0,
    taskId: "deploy-abc234",
    toolName: "deploy",
    workflowId: "workflow//eve//deploy",
  });
}

it.each([
  { output: "done", status: "completed" },
  { error: "failed", status: "failed" },
  { reason: "stop", status: "cancelled" },
] as const)("delivers a $status outcome only if its owner is still there", async (result) => {
  const message: WorkflowToolRunMessage = { from, kind: "outcome", result };

  await owner().handleMessage(message);

  expect(resumeHookStep).toHaveBeenCalledExactlyOnceWith("owner-inbox", message, {
    ifPresent: true,
  });
});

it("requires the owner for a report, which the owner waits on", async () => {
  const message: WorkflowToolRunMessage = { from, kind: "report", update: "halfway" };

  await owner().handleMessage(message);

  expect(resumeHookStep).toHaveBeenCalledExactlyOnceWith("owner-inbox", message, {
    ifPresent: false,
  });
});

it("reports that the outcome's owner is gone", async () => {
  vi.mocked(resumeHookStep).mockResolvedValue(false);

  await expect(
    owner().handleMessage({
      from,
      kind: "outcome",
      result: { output: "done", status: "completed" },
    }),
  ).resolves.toBe(false);
});
