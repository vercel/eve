import type { VersionMigration } from "./chain.js";
import type { WorkflowEntryInput } from "./workflow-entry.js";

/** Frozen migration for every pre-version workflow-entry input shape. */
export const workflowEntryInputV0ToV1: VersionMigration = {
  from: 0,
  migrate(prior: unknown): WorkflowEntryInput {
    if (
      typeof prior !== "object" ||
      prior === null ||
      !("input" in prior) ||
      !("serializedContext" in prior) ||
      typeof prior.serializedContext !== "object" ||
      prior.serializedContext === null
    ) {
      throw new Error(
        "workflow entry input: version 0 value is not a recognized pre-version shape.",
      );
    }
    return { ...prior, version: 1 } as WorkflowEntryInput;
  },
  to: 1,
};
