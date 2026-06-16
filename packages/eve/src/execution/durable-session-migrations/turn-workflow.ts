/**
 * Turn workflow input migrations.
 *
 * The driver workflow can stay pinned while per-turn child workflows
 * route to latest, so the child workflow run input is a durable wire
 * shape newer code must read. Inputs written before
 * {@link TURN_WORKFLOW_INPUT_VERSION} carry no `version`; the chain reads
 * them as version 0 and the registered v0 → v1 migration lifts the flat
 * shape into the current input, so a turn dispatched by an older
 * deployment still runs after a rollout. Future shape changes bump
 * {@link TURN_WORKFLOW_INPUT_VERSION} and append a v{N} → v{N+1} migration.
 */
import type { HookPayload, SessionCapabilities } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { RunMode } from "#shared/run-mode.js";

import { runMigrationChain, type VersionMigration } from "./chain.js";
import { turnWorkflowInputV0ToV1 } from "./turn-workflow-v0-to-v1.js";

export const TURN_WORKFLOW_INPUT_VERSION = 1;

export interface TurnStepInput {
  readonly input: HookPayload | undefined;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

export interface TurnWorkflowInput {
  readonly version: typeof TURN_WORKFLOW_INPUT_VERSION;
  readonly capabilities: SessionCapabilities | undefined;
  readonly completionToken: string;
  readonly mode: RunMode;
  readonly stepInput: TurnStepInput;
}

export interface TurnWorkflowDispatchInput {
  readonly capabilities: SessionCapabilities | undefined;
  readonly completionToken: string;
  readonly delivery: HookPayload;
  readonly mode: RunMode;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

const turnWorkflowInputMigrations: readonly VersionMigration[] = [turnWorkflowInputV0ToV1];

export function createTurnWorkflowInput(input: TurnWorkflowDispatchInput): TurnWorkflowInput {
  return {
    capabilities: input.capabilities,
    completionToken: input.completionToken,
    mode: input.mode,
    stepInput: {
      input: input.delivery,
      parentWritable: input.parentWritable,
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    },
    version: TURN_WORKFLOW_INPUT_VERSION,
  };
}

export function migrateTurnWorkflowInput(value: unknown): TurnWorkflowInput {
  // Inputs predating versioning carry no `version`; the chain reads them as
  // version 0 and walks the registered v0 → v1 migration.
  return runMigrationChain<TurnWorkflowInput>({
    initialVersion: 0,
    label: "turn workflow input",
    migrations: turnWorkflowInputMigrations,
    targetVersion: TURN_WORKFLOW_INPUT_VERSION,
    value,
  });
}
