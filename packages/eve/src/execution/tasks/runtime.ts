import { createHash } from "node:crypto";
import type { TaskRunWorkflowInput } from "#execution/tasks/workflow.js";
import { readStartedOwner } from "#execution/inbox/readiness.js";
import { sendInbox } from "#execution/inbox/send.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { startWorkflowOnCurrentDeployment } from "#execution/workflow-start.js";
import { taskRunWorkflowReference } from "#execution/workflow-references.js";
import { getRun, getHookByToken } from "#internal/workflow/runtime.js";
import {
  TASK_VIEW_STREAM_NAMESPACE,
  isTerminalTaskStatus,
  type TaskCommand,
  type TaskRunInboundPayload,
  type TaskView,
} from "#tasks/types.js";

export async function startTaskRun(
  input: TaskRunWorkflowInput,
): Promise<{ readonly runId: string }> {
  const started = await startWorkflowOnCurrentDeployment(taskRunWorkflowReference, [input]);
  const owner = await readStartedOwner(started.runId);
  return { runId: owner.ownerRunId };
}

export async function sendTaskCommand(input: {
  readonly command: TaskCommand;
  readonly taskInboxToken: string;
}): Promise<"delivered" | "unreachable"> {
  return (await sendTaskCommandToOwner(input)) === undefined ? "unreachable" : "delivered";
}

export async function sendTaskCommandToOwner(input: {
  readonly command: TaskCommand;
  readonly taskInboxToken: string;
}): Promise<{ readonly runId: string } | undefined> {
  return await sendTaskPayload(input.taskInboxToken, {
    command: input.command,
    kind: "task-command",
  });
}

export async function sendTaskInboundPayload(input: {
  readonly taskInboxToken: string;
  readonly payload: TaskRunInboundPayload;
}): Promise<"delivered" | "unreachable"> {
  return (await sendTaskPayload(input.taskInboxToken, input.payload)) === undefined
    ? "unreachable"
    : "delivered";
}

async function sendTaskPayload(
  token: string,
  payload: TaskRunInboundPayload,
): Promise<{ readonly runId: string } | undefined> {
  try {
    const owner = await getHookByToken(token);
    const eventId = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const delivered = await sendInbox(
      { ownerRunId: owner.runId, token },
      { eventId, kind: "task.command", payload },
    );
    return delivered === "delivered" ? { runId: owner.runId } : undefined;
  } catch (error) {
    if (isTaskWorkflowTargetGone(error)) return undefined;
    throw error;
  }
}

export async function readLatestTaskView(input: {
  readonly taskRunId: string;
}): Promise<TaskView | undefined> {
  const stream = getRun(input.taskRunId).getReadable<TaskView>({
    namespace: TASK_VIEW_STREAM_NAMESPACE,
    startIndex: -1,
  });
  if ((await stream.getTailIndex()) < 0) return undefined;
  const reader = stream.getReader();
  try {
    const next = await reader.read();
    return next.done ? undefined : next.value;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Waits on durable view appends, never repeated status or latest-state reads. */
export async function awaitTerminalTaskView(taskRunId: string): Promise<TaskView> {
  const run = getRun(taskRunId);
  const reader = run
    .getReadable<TaskView>({ namespace: TASK_VIEW_STREAM_NAMESPACE, startIndex: -1 })
    .getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) throw new Error(`Task workflow "${taskRunId}" ended without a terminal view.`);
      if (isTerminalTaskStatus(next.value.status)) return next.value;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
