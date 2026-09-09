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
import type {
  HookPayload,
  RuntimeActionResultHookPayload,
  SessionCapabilities,
} from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { RunMode } from "#shared/run-mode.js";
import type { DurableStepResult } from "#execution/next-driver-action.js";
import type { TurnCancelPayload } from "#execution/turn-cancellation-token.js";

import { runMigrationChain, type VersionMigration } from "./chain.js";
import { turnWorkflowInputV0ToV1 } from "./turn-workflow-v0-to-v1.js";
import { turnWorkflowInputV1ToV2 } from "./turn-workflow-v1-to-v2.js";

export const TURN_WORKFLOW_INPUT_VERSION = 2;

/** Trusted runtime-action results collected by the parent turn driver. */
interface RuntimeActionResultStepInput {
  readonly acceptedAtMsByCallId?: Readonly<Record<string, number>>;
  readonly kind: "runtime-action-result";
  readonly results: readonly RuntimeActionResult[];
}

export type TurnStepPayload =
  | Exclude<HookPayload, RuntimeActionResultHookPayload>
  | RuntimeActionResultStepInput;

export interface TurnStepInput {
  /** Cancellation signal forwarded into the turn step. */
  readonly abortSignal?: AbortSignal;
  /** Executes only on this Vercel deployment; mismatches defer before mutation. */
  readonly acceptedDeploymentId?: string;
  readonly input: TurnStepPayload | undefined;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

interface TurnWorkflowInputBase {
  readonly capabilities: SessionCapabilities | undefined;
  readonly completionToken: string;
  /**
   * Additive driver feature negotiation. Older pinned drivers omit this,
   * which keeps runtime-action orchestration on the legacy entry-owned path.
   */
  readonly driverCapabilities?: {
    readonly turnInbox?: true;
    readonly cancelledTurnSettle?: true;
  };
  readonly mode: RunMode;
  readonly stepInput: TurnStepInput;
}

/** A step completed inline before the turn needed the shared turn runner. */
export interface InitialTurnStep {
  readonly beforeStep: {
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
  };
  readonly result: DurableStepResult;
}

export type TurnWorkflowInput = TurnWorkflowInputBase &
  (
    | {
        readonly initialCancellation?: undefined;
        readonly initialStep?: undefined;
        readonly version: 1;
      }
    | {
        readonly initialCancellation?: TurnCancelPayload;
        readonly initialStep?: InitialTurnStep;
        readonly version: typeof TURN_WORKFLOW_INPUT_VERSION;
      }
  );

export interface TurnWorkflowDispatchInput {
  readonly capabilities: SessionCapabilities | undefined;
  readonly completionToken: string;
  readonly delivery: HookPayload;
  readonly mode: RunMode;
  readonly initialStep?: InitialTurnStep;
  readonly initialCancellation?: TurnCancelPayload;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

const turnWorkflowInputMigrations: readonly VersionMigration[] = [
  turnWorkflowInputV0ToV1,
  turnWorkflowInputV1ToV2,
];

export function createTurnWorkflowInput(input: TurnWorkflowDispatchInput): TurnWorkflowInput {
  return {
    capabilities: input.capabilities,
    completionToken: input.completionToken,
    driverCapabilities: { cancelledTurnSettle: true, turnInbox: true },
    initialCancellation: input.initialCancellation,
    initialStep: input.initialStep,
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
