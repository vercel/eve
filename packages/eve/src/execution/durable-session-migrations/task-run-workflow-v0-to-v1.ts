import type { VersionMigration } from "./chain.js";
import type { TaskRunWorkflowInput } from "./task-run-workflow.js";

/** Frozen migration for both pre-version task inbox token names. */
export const taskRunWorkflowInputV0ToV1: VersionMigration = {
  from: 0,
  migrate(prior: unknown): TaskRunWorkflowInput {
    if (typeof prior !== "object" || prior === null) {
      throw new Error(
        "task run workflow input: version 0 value is not a recognized pre-version shape.",
      );
    }
    const candidate = prior as {
      readonly continuationToken?: unknown;
      readonly initialView?: unknown;
      readonly parentContinuationToken?: unknown;
      readonly taskInboxToken?: unknown;
    };
    const taskInboxToken =
      typeof candidate.taskInboxToken === "string"
        ? candidate.taskInboxToken
        : candidate.continuationToken;
    if (
      typeof taskInboxToken !== "string" ||
      typeof candidate.initialView !== "object" ||
      candidate.initialView === null ||
      typeof candidate.parentContinuationToken !== "string"
    ) {
      throw new Error(
        "task run workflow input: version 0 value is not a recognized pre-version shape.",
      );
    }
    return {
      ...prior,
      continuationToken: taskInboxToken,
      taskInboxToken,
      version: 1,
    } as TaskRunWorkflowInput;
  },
  to: 1,
};
