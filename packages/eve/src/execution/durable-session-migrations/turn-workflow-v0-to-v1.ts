/**
 * Turn workflow input v0 → v1 migration.
 *
 * Before versioning, the driver wrote a flat, unversioned run input;
 * `runMigrationChain` reads that as version 0 (via its `initialVersion`
 * option) and this lifts the flat shape into the nested v1 input. The
 * reshape is inlined rather than delegating to `createTurnWorkflowInput`,
 * so the historical transform stays frozen as the live dispatch
 * constructor evolves.
 */
import type { VersionMigration } from "./chain.js";
import type { TurnWorkflowDispatchInput, TurnWorkflowInput } from "./turn-workflow.js";

export const turnWorkflowInputV0ToV1: VersionMigration = {
  from: 0,
  migrate(prior: unknown): TurnWorkflowInput {
    if (!isPreVersionTurnWorkflowInput(prior)) {
      throw new Error(
        "turn workflow input: version 0 value is not a recognized pre-version shape.",
      );
    }
    return {
      capabilities: prior.capabilities,
      completionToken: prior.completionToken,
      mode: prior.mode,
      stepInput: {
        input: prior.delivery,
        parentWritable: prior.parentWritable,
        serializedContext: prior.serializedContext,
        sessionState: prior.sessionState,
      },
      version: 1,
    };
  },
  to: 1,
};

function isPreVersionTurnWorkflowInput(value: unknown): value is TurnWorkflowDispatchInput {
  return typeof value === "object" && value !== null && "delivery" in value;
}
