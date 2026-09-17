/**
 * Session-owned invocation identity, admission acknowledgement, and dispatch rejection.
 * The parent commits its session index before releasing the workflow body.
 */
import type { HarnessSession } from "#harness/types.js";
import {
  readLatestTaskView,
  sendTaskCommand,
  sendTaskCommandToOwner,
} from "#execution/tasks/parent/run-parent.js";
import type { JsonValue } from "#shared/json.js";
import { deriveTaskInboxToken, deriveTaskId } from "#tasks/task-id.js";
import { isTerminalTaskStatus, type TaskMetadata } from "#tasks/types.js";
import type { TaskAgentDispatchContext } from "#tasks/session-index.js";
import type { ContextReader } from "#context/key.js";
import {
  SessionDynamicSubagentSelectionsKey,
  TurnDynamicSubagentSelectionsKey,
  type SessionAuth,
} from "#context/keys.js";

/** A prepared background task: identity plus its started durable run. */
export type BackgroundTask = import("#harness/workflow-invocations.js").TaskWorkflowInvocation;

export function createTaskAgentDispatchContext(
  ctx: ContextReader,
  auth: SessionAuth,
): TaskAgentDispatchContext {
  return {
    auth,
    sessionDynamicSubagentSelections: ctx.get(SessionDynamicSubagentSelectionsKey),
    turnDynamicSubagentSelections: ctx.get(TurnDynamicSubagentSelectionsKey),
  };
}

export type BackgroundTaskDraft = Omit<BackgroundTask, "address"> & {
  readonly address: { readonly hookToken: string };
};

/** Derives the replay-stable task identity before its owning run is started. */
export function prepareBackgroundTask(input: {
  readonly callId: string;
  readonly dispatchContext: TaskAgentDispatchContext;
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
    callId: input.callId,
    toolName: input.metadata.name,
    resultKind: input.metadata.kind === "subagent" ? "subagent" : "tool",
    lifetime: "session",
    origin: { turnId: input.parentTurnId, stepIndex: input.parentStepIndex ?? 0 },
    address: {
      hookToken: deriveTaskInboxToken({
        parentContinuationToken: input.session.continuationToken,
        taskId,
      }),
    },
    task: { dispatchContext: input.dispatchContext, metadata: input.metadata, taskId },
  };
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
      retryUnreachable: { attempts: 20, delayMs: 250 },
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
    taskInboxToken: input.task.address.hookToken,
    retryUnreachable: { attempts: 20, delayMs: 250 },
  });
}
