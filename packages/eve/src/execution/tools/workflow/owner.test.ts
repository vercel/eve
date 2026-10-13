import { expect, it, vi } from "vitest";

import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { raceChannelReads } from "#execution/tools/workflow/owner-channels.js";
import { openWorkflowToolRunOwnerInbox } from "#execution/tools/workflow/owner.js";
import { createBlockingWorkflow } from "#execution/tools/workflow/workflow-owner-blocking.js";
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";

const mocks = vi.hoisted(() => ({ resumeHookStep: vi.fn(async () => {}) }));

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }),
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({
  resumeHookStep: mocks.resumeHookStep,
}));

const from = {
  callId: "call-1",
  input: {},
  runId: "run-1",
  sequence: 0,
  stepIndex: 0,
  taskId: "task-1",
  toolName: "triage_issues",
  turnId: "turn-1",
};

function opened(sessionId: string): Extract<WorkflowToolRunMessage, { kind: "agent-started" }> {
  return {
    from,
    kind: "agent-started",
    session: {
      continuationToken: `subagent:${sessionId}`,
      kind: "local",
      name: "reviewer",
      nodeId: "reviewer",
      sessionId,
    },
  };
}

it("relays what a fan-out sent between relays as one delivery, in order", async () => {
  const inbox = openWorkflowToolRunOwnerInbox();
  const owner = createBlockingWorkflow({
    owner: { inbox: "session-inbox" },
  } as WorkflowToolRunInput);
  // Alice's triage opens three reviewers before the run reads its inbox.
  for (const sessionId of ["child-1", "child-2", "child-3"])
    await inbox.owner.send(opened(sessionId));

  const read = await raceChannelReads([inbox.reader]);
  if (read.next.done) throw new Error("The inbox ended.");
  await owner.relay(read.next.value);

  expect(inbox.owner.sent).toBe(3);
  expect(mocks.resumeHookStep).toHaveBeenCalledExactlyOnceWith("session-inbox", {
    kind: "workflow-batch",
    messages: [opened("child-1"), opened("child-2"), opened("child-3")],
  });
});

it("splits what queued up into deliveries of at most 64,000 characters, in order", async () => {
  const inbox = openWorkflowToolRunOwnerInbox();
  const report = (
    label: string,
    size: number,
  ): Extract<WorkflowToolRunMessage, { kind: "report" }> => ({
    from,
    kind: "report",
    update: label.padEnd(size, "."),
  });
  // Alice's reviewers report long findings faster than the run relays them.
  const sent = [
    report("first", 25_000),
    report("second", 25_000),
    report("third", 25_000),
    report("oversized", 70_000),
    report("fifth", 10),
    report("sixth", 10),
  ];
  for (const message of sent) await inbox.owner.send(message);

  const deliveries: WorkflowToolRunMessage[][] = [];
  while (deliveries.flat().length < sent.length) {
    const read = await raceChannelReads([inbox.reader]);
    if (read.next.done) throw new Error("The inbox ended.");
    deliveries.push(read.next.value);
  }

  expect(deliveries).toEqual([sent.slice(0, 2), sent.slice(2, 3), sent.slice(3, 4), sent.slice(4)]);
});

it("relays a lone message as itself", async () => {
  mocks.resumeHookStep.mockClear();
  const owner = createBlockingWorkflow({
    owner: { inbox: "session-inbox" },
  } as WorkflowToolRunInput);

  await owner.relay([opened("child-1")]);

  expect(mocks.resumeHookStep).toHaveBeenCalledExactlyOnceWith("session-inbox", opened("child-1"), {
    ifPresent: false,
  });
});
