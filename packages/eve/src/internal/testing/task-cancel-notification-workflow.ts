import { createHook, getWorkflowMetadata, sleep } from "#compiled/@workflow/core/index.js";

import { createSessionCommandInbox } from "#execution/session-command-inbox.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { appendTaskViewStep } from "#execution/tasks/child/steps.js";
import { cancelOwnedTask } from "#execution/tasks/parent/dispatch.js";
import { waitForCommandHookOwner } from "#execution/workflow-runtime.js";
import { getRun, start } from "#internal/workflow/runtime.js";
import type { HarnessSession } from "#harness/types.js";
import type { SessionTaskIndexEntry } from "#tasks/session-index.js";
import type { TaskCommandHookPayload } from "#tasks/types.js";

/** Models a task whose view commits before its executor finishes unwinding. */
export async function slowCancelledTaskWorkflow(input: {
  readonly taskId: string;
  readonly taskInboxToken: string;
}): Promise<void> {
  "use workflow";

  using commands = createHook<TaskCommandHookPayload>({ token: input.taskInboxToken });
  const metadata = { kind: "tool", name: "slow-cancel" } as const;
  await appendTaskViewStep({ view: { metadata, status: "working", taskId: input.taskId } });
  const delivery = await commands;
  if (delivery.kind !== "task-command" || delivery.command.kind !== "cancel") {
    throw new Error("Expected the task cancellation command.");
  }
  await appendTaskViewStep({ view: { metadata, status: "cancelled", taskId: input.taskId } });
  await sleep("1h");
}

export async function startSlowCancelledTaskStep(input: {
  readonly sessionId: string;
}): Promise<SessionTaskIndexEntry> {
  "use step";

  const taskId = `${input.sessionId}-task`;
  const taskInboxToken = `${input.sessionId}:slow-cancel`;
  const run = await start(slowCancelledTaskWorkflow, [{ taskId, taskInboxToken }]);
  await waitForCommandHookOwner(taskInboxToken);
  return {
    createdByTurnId: "turn_0",
    metadata: { kind: "tool", name: "slow-cancel" },
    taskId,
    taskInboxToken,
    taskRunId: run.runId,
  };
}

export async function cancelSlowTaskFromParentStep(input: {
  readonly entry: SessionTaskIndexEntry;
  readonly sessionId: string;
}) {
  "use step";

  const view = await cancelOwnedTask({
    entry: input.entry,
    session: { sessionId: input.sessionId } as HarnessSession,
  });
  return { view, taskRunStatus: await getRun(input.entry.taskRunId).status };
}

export async function taskCancelNotificationWorkflow() {
  "use workflow";

  const { workflowRunId: sessionId } = getWorkflowMetadata();
  const inbox = createSessionCommandInbox();
  try {
    await inbox.claimStable(sessionCommandHookToken(sessionId));
    const entry = await startSlowCancelledTaskStep({ sessionId });
    const cancelled = await cancelSlowTaskFromParentStep({ entry, sessionId });
    const next = await inbox.next();
    inbox.consumeNext();
    return { ...cancelled, notification: next.value };
  } finally {
    await inbox.dispose();
  }
}
