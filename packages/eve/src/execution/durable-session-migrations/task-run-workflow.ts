import type { TaskView } from "#tasks/types.js";

import { runMigrationChain, type VersionMigration } from "./chain.js";
import { taskRunWorkflowInputV0ToV1 } from "./task-run-workflow-v0-to-v1.js";

export const TASK_RUN_WORKFLOW_INPUT_VERSION = 1;

export interface TaskRunWorkflowInput {
  /** Historical task inbox name retained for older workflow consumers. */
  readonly continuationToken: string;
  readonly initialView: TaskView;
  readonly parentContinuationToken: string;
  readonly taskInboxToken: string;
  readonly version: typeof TASK_RUN_WORKFLOW_INPUT_VERSION;
}

export type TaskRunWorkflowDispatchInput = Omit<
  TaskRunWorkflowInput,
  "continuationToken" | "version"
>;

const taskRunWorkflowInputMigrations: readonly VersionMigration[] = [taskRunWorkflowInputV0ToV1];

export function createTaskRunWorkflowInput(
  input: TaskRunWorkflowDispatchInput,
): TaskRunWorkflowInput {
  return {
    ...input,
    continuationToken: input.taskInboxToken,
    version: TASK_RUN_WORKFLOW_INPUT_VERSION,
  };
}

export function migrateTaskRunWorkflowInput(value: unknown): TaskRunWorkflowInput {
  return runMigrationChain<TaskRunWorkflowInput>({
    initialVersion: 0,
    label: "task run workflow input",
    migrations: taskRunWorkflowInputMigrations,
    targetVersion: TASK_RUN_WORKFLOW_INPUT_VERSION,
    value,
  });
}
