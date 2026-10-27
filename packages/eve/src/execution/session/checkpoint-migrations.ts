import { SESSION_CHECKPOINT_VERSION, type SessionCheckpoint } from "#execution/session/handoff.js";
import { isObject } from "#shared/guards.js";
import {
  DELIVERY_IDEMPOTENCY_WINDOW,
  MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH,
} from "#channel/delivery-idempotency.js";
import { upgradeV26Checkpoint, type V26CarriedState } from "#execution/session/v26-checkpoint.js";

/**
 * Oldest checkpoint a successor accepts: eve 0.83's, the last whose stream holds v26 lines. An
 * idle one moves: v27 reads its stream, and the successor rebuilds the projection from it. Older
 * sessions stay on the deployment that owns them.
 */
export const MIN_SESSION_CHECKPOINT_VERSION = 17;

export type SessionCheckpointMigration =
  | {
      readonly kind: "current";
      readonly checkpoint: SessionCheckpoint;
      /**
       * Present for a checkpoint a v26 owner wrote: its projection is absent, and the successor
       * rebuilds it from the session's stream with what the owner counted.
       */
      readonly v26?: V26CarriedState;
    }
  | { readonly kind: "incompatible"; readonly detail: string };

type CheckpointRecord = Record<string, unknown>;

/**
 * One pure upgrade per checkpoint version, keyed by the version it reads. Bumping
 * `SESSION_CHECKPOINT_VERSION` within v27 adds the step from the previous version: a successor
 * accepts its predecessors' checkpoints back to {@link MIN_SESSION_CHECKPOINT_VERSION}. A step
 * refuses state the current build cannot continue, such as work still in flight; the owner then
 * keeps the session.
 */
const CHECKPOINT_UPGRADES: Readonly<
  Record<number, (checkpoint: CheckpointRecord, effects: UpgradeEffects) => CheckpointRecord>
> = {
  // The stream's first v27 lines follow the v26 ones an eve 0.83 owner wrote.
  17: (checkpoint, effects) => {
    const upgraded = upgradeV26Checkpoint(checkpoint, refuse);
    effects.v26 = upgraded.carried;
    return upgraded.checkpoint;
  },
};

interface UpgradeEffects {
  v26?: V26CarriedState;
}

/**
 * Upgrades a checkpoint written by an older eve build to the current shape.
 * Pure, so the session workflow can run it before validation. Newer
 * checkpoints and those older than {@link MIN_SESSION_CHECKPOINT_VERSION} are
 * incompatible.
 */
export function migrateSessionCheckpoint(checkpoint: unknown): SessionCheckpointMigration {
  if (!isObject(checkpoint)) return { kind: "incompatible", detail: "checkpoint is not an object" };
  const { version } = checkpoint;
  if (typeof version === "number" && version < MIN_SESSION_CHECKPOINT_VERSION) {
    return {
      kind: "incompatible",
      detail: `checkpoint version ${version} predates eve 0.83; the session continues on the deployment that owns it`,
    };
  }
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version > SESSION_CHECKPOINT_VERSION
  ) {
    return {
      kind: "incompatible",
      detail: `checkpoint version ${JSON.stringify(version)} is outside the supported range ${MIN_SESSION_CHECKPOINT_VERSION}-${SESSION_CHECKPOINT_VERSION}`,
    };
  }
  let current: CheckpointRecord = checkpoint;
  const effects: UpgradeEffects = {};
  try {
    for (let from = version; from < SESSION_CHECKPOINT_VERSION; from++) {
      const upgrade = CHECKPOINT_UPGRADES[from];
      if (upgrade === undefined) refuse(`no upgrade from checkpoint version ${from}`);
      current = { ...upgrade(current, effects), version: from + 1 };
    }
  } catch (error) {
    if (!(error instanceof CheckpointRefusal)) throw error;
    return { kind: "incompatible", detail: `checkpoint version ${version}: ${error.message}` };
  }
  if (!isCurrentCheckpoint(current)) {
    return { kind: "incompatible", detail: `checkpoint version ${version} is incomplete` };
  }
  return effects.v26 === undefined
    ? { kind: "current", checkpoint: current }
    : { kind: "current", checkpoint: current, v26: effects.v26 };
}

function isCurrentCheckpoint(value: unknown): value is SessionCheckpoint {
  return (
    isObject(value) &&
    value.version === SESSION_CHECKPOINT_VERSION &&
    Array.isArray(value.admittedDeliveryKeys) &&
    value.admittedDeliveryKeys.length <= DELIVERY_IDEMPOTENCY_WINDOW &&
    value.admittedDeliveryKeys.every(
      (key) =>
        typeof key === "string" &&
        key.length > 0 &&
        key.length <= MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH,
    ) &&
    Array.isArray(value.history) &&
    isObject(value.serializedContext) &&
    isObject(value.sessionState)
  );
}

class CheckpointRefusal extends Error {}

function refuse(detail: string): never {
  throw new CheckpointRefusal(detail);
}
