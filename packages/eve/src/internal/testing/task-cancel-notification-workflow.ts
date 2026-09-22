import { createHook, getWorkflowMetadata, sleep } from "#compiled/@workflow/core/index.js";

import { createSessionInbox } from "#execution/session-inbox/inbox.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { cancelOwnedTask } from "#execution/tasks/parent/dispatch.js";
import { waitForCommandHookOwner } from "#execution/workflow-runtime.js";
import { getRun, start } from "#internal/workflow/runtime.js";
import type { HarnessSession } from "#harness/types.js";
import type { BackgroundWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import type { TaskCommandHookPayload } from "#tasks/types.js";

/** Models a task whose executor cannot finish cooperative cleanup. */
export async function slowCancelledTaskWorkflow(input: {
  readonly taskId: string;
  readonly taskInboxToken: string;
}): Promise<void> {
  "use workflow";

  using commands = createHook<TaskCommandHookPayload>({ token: input.taskInboxToken });
  const delivery = await commands;
  if (delivery.kind !== "task-command" || delivery.command.kind !== "cancel") {
    throw new Error("Expected the task cancellation command.");
  }
  await sleep("1h");
}

export async function startSlowCancelledTaskStep(input: {
  readonly sessionId: string;
}): Promise<BackgroundWorkflowToolRun> {
  "use step";

  const taskId = `${input.sessionId}-task`;
  const taskInboxToken = `${input.sessionId}:slow-cancel`;
  const run = await start(slowCancelledTaskWorkflow, [{ taskId, taskInboxToken }]);
  await waitForCommandHookOwner(taskInboxToken);
  return {
    callId: taskId,
    toolName: { kind: "tool", name: "slow-cancel" }.name,
    lifetime: "session" as const,
    origin: { turnId: "turn_0", stepIndex: 0 },
    address: { runId: run.runId, hookToken: taskInboxToken },
    task: {
      dispatchContext: { auth: { current: null, initiator: null } },
      metadata: { kind: "tool", name: "slow-cancel" },
      taskId,
    },
  };
}

export async function cancelSlowTaskFromParentStep(input: {
  readonly entry: BackgroundWorkflowToolRun;
  readonly sessionId: string;
}) {
  "use step";

  const view = await cancelOwnedTask({
    entry: input.entry,
    session: { sessionId: input.sessionId } as HarnessSession,
  });
  return { view, taskRunStatus: await getRun(input.entry.address.runId).status };
}

export async function taskCancelNotificationWorkflow() {
  "use workflow";

  const { workflowRunId: sessionId } = getWorkflowMetadata();
  const inbox = createSessionInbox(sessionId);
  try {
    await inbox.claimSessionHook(sessionCommandHookToken(sessionId));
    const entry = await startSlowCancelledTaskStep({ sessionId });
    const cancelled = await cancelSlowTaskFromParentStep({ entry, sessionId });
    const notification = await inbox.next();
    if (notification === undefined)
      throw new Error("Session inbox closed before task cancellation.");
    return { ...cancelled, notification };
  } finally {
    await inbox.dispose();
  }
}
