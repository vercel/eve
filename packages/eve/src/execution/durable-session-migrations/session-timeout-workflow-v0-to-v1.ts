import type { VersionMigration } from "./chain.js";
import type { SessionTimeoutWorkflowInput } from "./session-timeout-workflow.js";

/** Frozen migration for the original session-timeout workflow input. */
export const sessionTimeoutWorkflowInputV0ToV1: VersionMigration = {
  from: 0,
  migrate(prior: unknown): SessionTimeoutWorkflowInput {
    if (
      typeof prior !== "object" ||
      prior === null ||
      !("deadline" in prior) ||
      !(prior.deadline instanceof Date) ||
      !("token" in prior) ||
      typeof prior.token !== "string"
    ) {
      throw new Error(
        "session timeout workflow input: version 0 value is not a recognized pre-version shape.",
      );
    }
    return { ...prior, version: 1 } as SessionTimeoutWorkflowInput;
  },
  to: 1,
};
