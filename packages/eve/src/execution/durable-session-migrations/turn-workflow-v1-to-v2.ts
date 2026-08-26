import type { VersionMigration } from "#execution/durable-session-migrations/chain.js";

/** Version 2 carries the selected direct-agent node through every step in a turn. */
export const turnWorkflowInputV1ToV2: VersionMigration = {
  from: 1,
  to: 2,
  migrate(prior) {
    if (
      typeof prior !== "object" ||
      prior === null ||
      !("stepInput" in prior) ||
      typeof prior.stepInput !== "object" ||
      prior.stepInput === null
    ) {
      throw new Error("turn workflow input: version 1 value is not a recognized shape.");
    }
    const stepInput = prior.stepInput as Record<string, unknown>;
    return {
      ...prior,
      stepInput: {
        ...stepInput,
        agentNodeId: undefined,
        defaultBundle: (stepInput.serializedContext as Record<string, unknown>)["eve.bundle"],
      },
      version: 2,
    };
  },
};
