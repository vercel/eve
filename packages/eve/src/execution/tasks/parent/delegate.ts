/**
 * Generic task creation, readiness acknowledgement, and dispatch rejection.
 * Task-run transport (start/command/view) lives in `run-parent.ts`, which
 * Callers compose these primitives around their own executor policy.
 */
import type { ActivityObserverConfig } from "#channel/types.js";
import type { HarnessSession } from "#harness/types.js";
import {
  readLatestTaskView,
  sendTaskCommand,
  sendTaskCommandToOwner,
  startTaskRun,
} from "#execution/tasks/parent/run-parent.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import type { JsonValue } from "#shared/json.js";
import type { TaskExecutorBinding } from "#tools/task.js";
import { deriveTaskInboxToken, deriveTaskId } from "#tasks/task-id.js";
import { isTerminalTaskStatus, type TaskMetadata } from "#tasks/types.js";

/** A prepared background task: identity plus its started durable run. */
export interface BackgroundTask {
  readonly taskInboxToken: string;
  readonly createdByStepIndex?: number;
  readonly createdByTurnId: string;
  readonly executor?: TaskExecutorBinding;
  readonly metadata: TaskMetadata;
  readonly taskId: string;
  readonly taskRunId: string;
}

type BackgroundTaskDraft = Omit<BackgroundTask, "taskRunId">;

/** Derives the replay-stable task identity before its owning run is started. */
export function prepareBackgroundTask(input: {
  readonly callId: string;
  readonly metadata: TaskMetadata;
  readonly parentSessionId: string;
  readonly parentStepIndex?: number;
  readonly parentTurnId: string;
  readonly session: HarnessSession;
}): BackgroundTaskDraft {
  const taskId = deriveTaskId({
    callId: input.callId,
    parentSessionId: input.parentSessionId,
    parentTurnId: input.parentTurnId,
  });
  return {
    taskInboxToken: deriveTaskInboxToken({
      parentContinuationToken: input.session.continuationToken,
      taskId,
    }),
    createdByStepIndex: input.parentStepIndex ?? 0,
    createdByTurnId: input.parentTurnId,
    metadata: input.metadata,
    taskId,
  };
}

/** Starts a lifecycle-only task run for a non-workflow external executor. */
export async function beginBackgroundTask(input: {
  readonly activityObserver?: ActivityObserverConfig;
  readonly callId: string;
  readonly metadata: TaskMetadata;
  readonly parentSessionId: string;
  readonly parentStepIndex?: number;
  readonly parentTurnId: string;
  readonly session: HarnessSession;
}): Promise<BackgroundTask> {
  const task = prepareBackgroundTask(input);
  const owner = await startTaskRun({
    activityObserver: input.activityObserver,
    taskInboxToken: task.taskInboxToken,
    initialView: { metadata: task.metadata, status: "working", taskId: task.taskId },
    parentContinuationToken: sessionCommandHookToken(input.session.sessionId),
  });
  return { ...task, taskRunId: owner.runId };
}

/** Releases task events only after the parent session index committed. */
export async function acknowledgeDelegatedTasksStep(input: {
  readonly tasks: readonly {
    readonly taskInboxToken: string;
    readonly taskId: string;
    readonly taskRunId: string;
  }[];
}): Promise<void> {
  "use step";

  for (const task of input.tasks) {
    const owner = await sendTaskCommandToOwner({
      command: { kind: "ready" },
      taskInboxToken: task.taskInboxToken,
    });
    if (owner !== undefined) continue;
    const view = await readLatestTaskView({ taskRunId: task.taskRunId });
    if (view !== undefined && isTerminalTaskStatus(view.status)) continue;
    throw new Error(`Task run "${task.taskId}" did not accept its readiness command.`);
  }
}

/** Silently terminates a task whose child dispatch failed before parent indexing. */
export async function rejectDelegatedDispatch(input: {
  readonly error: JsonValue;
  readonly task: BackgroundTask;
}): Promise<void> {
  await sendTaskCommand({
    command: { data: input.error, kind: "reject-dispatch" },
    taskInboxToken: input.task.taskInboxToken,
  });
}
