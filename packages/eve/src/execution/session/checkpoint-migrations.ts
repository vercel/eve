import { SESSION_CHECKPOINT_VERSION, type SessionCheckpoint } from "#execution/session/handoff.js";
import { isObject } from "#shared/guards.js";

/**
 * Oldest checkpoint a successor accepts: the first that writes v27 session events. A session
 * whose stream began in the earlier shape stays on the deployment that owns it, since its
 * stream's lines, projection, and private records of running work changed shape together.
 */
export const MIN_SESSION_CHECKPOINT_VERSION = 15;

export type SessionCheckpointMigration =
  | {
      readonly kind: "current";
      readonly checkpoint: SessionCheckpoint;
      /** Idle child sessions the current build no longer tracks; the successor stops them. */
      readonly childRunIdsToStop: readonly string[];
    }
  | { readonly kind: "incompatible"; readonly detail: string };

type CheckpointRecord = Record<string, unknown>;

interface UpgradeEffects {
  readonly childRunIdsToStop: string[];
}

/**
 * One pure upgrade per checkpoint version, keyed by the version it reads. Bumping
 * `SESSION_CHECKPOINT_VERSION` within v27 adds the step from the previous version: a successor
 * accepts its predecessors' checkpoints back to {@link MIN_SESSION_CHECKPOINT_VERSION}. A step
 * refuses state the current build cannot continue, such as work still in flight; the owner then
 * keeps the session.
 */
const CHECKPOINT_UPGRADES: Readonly<
  Record<number, (checkpoint: CheckpointRecord, effects: UpgradeEffects) => CheckpointRecord>
> = {};

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
      detail: `checkpoint version ${version} predates v27 session events; the session continues on the deployment that owns it`,
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
  const effects: UpgradeEffects = { childRunIdsToStop: [] };
  let current: CheckpointRecord = checkpoint;
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
  return { kind: "current", checkpoint: current, childRunIdsToStop: effects.childRunIdsToStop };
}

function isCurrentCheckpoint(value: unknown): value is SessionCheckpoint {
  return (
    isObject(value) &&
    value.version === SESSION_CHECKPOINT_VERSION &&
    Array.isArray(value.history) &&
    isObject(value.serializedContext) &&
    isObject(value.sessionState)
  );
}

class CheckpointRefusal extends Error {}

function refuse(detail: string): never {
  throw new CheckpointRefusal(detail);
}
