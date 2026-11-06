import {
  SESSION_CHECKPOINT_VERSION,
  type SessionCheckpoint,
} from "#execution/session/checkpoint.js";
import {
  importPreV27Checkpoint,
  isPreV27CheckpointVersion,
  type PreV27Checkpoint,
} from "#execution/session/pre-v27-checkpoint.js";
import { CheckpointRefusal, refuse } from "#execution/session/checkpoint-refusal.js";
import { REACTIONS_STATE_KEY } from "#definitions/continuation.js";
import { isObject } from "#shared/guards.js";
import type { JsonValue } from "#shared/json.js";
import {
  DELIVERY_IDEMPOTENCY_WINDOW,
  MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH,
} from "#channel/delivery-idempotency.js";

/**
 * Oldest checkpoint a successor upgrades in place: the first that writes v27 session events.
 * Older ones, from an owner before v27, are imported instead (`pre-v27-checkpoint.ts`): their
 * stream's lines, projection, and private records of running work changed shape together, so the
 * successor also folds their stream before it continues.
 */
export const MIN_SESSION_CHECKPOINT_VERSION = 18;

export type SessionCheckpointMigration =
  | { readonly kind: "current"; readonly checkpoint: SessionCheckpoint }
  /** A checkpoint from an owner before v27, still without the projection its stream holds. */
  | { readonly kind: "pre-v27"; readonly imported: PreV27Checkpoint }
  /** An owner before v27 still runs work for the session; a later delivery can move it. */
  | { readonly kind: "busy"; readonly detail: string }
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
  Record<number, (checkpoint: CheckpointRecord) => CheckpointRecord>
> = {
  // 19 renders the system prompt from the deployment's files on every model call, so the session
  // no longer stores the prompt it last rendered, and its definitions keep what 18 recorded beside
  // them. An owner that reads 18 or less refuses 19.
  18: (checkpoint) => withDefinitionRecords(withoutStoredPrompt(checkpoint)),
};

const OFFERED_CATALOG_TOOLS_KEY = "eve.offeredCatalogTools";
const HISTORY_STATE_KEY = "eve.historyState";
const CATALOG_SLOT = "eve.catalog";

/**
 * Moves what 18 recorded beside its definitions into their state. The catalog tools the session
 * was offered become the catalog's kept value. The digest of each user instruction a dynamic file
 * added becomes that instruction's announcement, but only while the history still holds it: one a
 * compaction or clear removed is announced again.
 */
function withDefinitionRecords(checkpoint: CheckpointRecord): CheckpointRecord {
  const context = checkpoint.serializedContext;
  if (!isObject(context)) return checkpoint;
  const {
    [OFFERED_CATALOG_TOOLS_KEY]: offered,
    [REACTIONS_STATE_KEY]: reactions,
    ...rest
  } = context;
  const { appended, ...state } = isObject(reactions) ? reactions : {};
  if (offered === undefined && appended === undefined) return checkpoint;
  const slots = isObject(state.slots) ? state.slots : {};
  const latest = isObject(state.latest) ? state.latest : {};
  const catalog = offeredCatalogTools(offered);
  const held = heldInstructions(appended, slots, checkpoint.history);
  const history = isObject(rest[HISTORY_STATE_KEY]) ? rest[HISTORY_STATE_KEY] : {};
  return {
    ...checkpoint,
    serializedContext: {
      ...rest,
      [REACTIONS_STATE_KEY]: {
        ...state,
        latest,
        slots: {
          ...(catalog !== undefined && {
            [CATALOG_SLOT]: {
              // The session workflow runs this, where eve can't hash: a digest no value has, which
              // the catalog replaces with its own at the next model call.
              digest: "",
              since: typeof latest["*"] === "number" ? latest["*"] : 0,
              value: catalog,
            },
          }),
          ...slots,
        },
      },
      ...(held.length > 0 && {
        [HISTORY_STATE_KEY]: {
          ...history,
          announcements: { ...Object.fromEntries(held), ...(history.announcements as object) },
        },
      }),
    },
  };
}

/** The digests 18 recorded for dynamic user instructions whose content the history still holds. */
function heldInstructions(
  appended: unknown,
  slots: CheckpointRecord,
  history: unknown,
): [string, string][] {
  const said = new Set(
    (Array.isArray(history) ? history : []).flatMap((message) =>
      isObject(message) && message.kind === "context.instruction" ? [message.content] : [],
    ),
  );
  return Object.entries(isObject(appended) ? appended : {}).flatMap(([id, digest]) => {
    const slot = slots[id];
    const value = isObject(slot) && isObject(slot.value) ? slot.value : {};
    return typeof digest === "string" && value.role === "user" && said.has(value.content)
      ? [[id, digest] as [string, string]]
      : [];
  });
}

/** 18's record of the catalog tools offered, if it offered any. */
function offeredCatalogTools(offered: unknown): Record<string, JsonValue> | undefined {
  if (!isObject(offered)) return undefined;
  const tools = {
    connections: offered.connections === true,
    searchableSkills: offered.searchableSkills === true,
    skills: offered.skills === true,
    tools: offered.tools === true,
  };
  return Object.values(tools).includes(true) ? tools : undefined;
}

function withoutStoredPrompt(checkpoint: CheckpointRecord): CheckpointRecord {
  const state = checkpoint.sessionState;
  if (!isObject(state) || !isObject(state.snapshot) || !isObject(state.snapshot.session))
    return checkpoint;
  const { agent: _agent, ...session } = state.snapshot.session;
  return { ...checkpoint, sessionState: { ...state, snapshot: { ...state.snapshot, session } } };
}

/**
 * Upgrades a checkpoint written by an older eve build to the current shape.
 * Pure, so the session workflow can run it before validation. Newer
 * checkpoints and those older than eve 0.69 are incompatible.
 */
export function migrateSessionCheckpoint(checkpoint: unknown): SessionCheckpointMigration {
  if (!isObject(checkpoint)) return { kind: "incompatible", detail: "checkpoint is not an object" };
  const { version } = checkpoint;
  if (isPreV27CheckpointVersion(version)) {
    const result = importPreV27Checkpoint({ ...checkpoint, version });
    if (result.kind !== "pre-v27") return result;
    const { imported } = result;
    const upgraded = withDefinitionRecords(imported.checkpoint);
    if (!isCurrentCheckpoint(upgraded)) {
      return { kind: "incompatible", detail: `checkpoint version ${version} is incomplete` };
    }
    return { kind: "pre-v27", imported: { ...imported, checkpoint: upgraded } };
  }
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < MIN_SESSION_CHECKPOINT_VERSION ||
    version > SESSION_CHECKPOINT_VERSION
  ) {
    return {
      kind: "incompatible",
      detail: `checkpoint version ${JSON.stringify(version)} is outside the supported ranges: 10-17 import, ${MIN_SESSION_CHECKPOINT_VERSION}-${SESSION_CHECKPOINT_VERSION} upgrade`,
    };
  }
  let current: CheckpointRecord = checkpoint;
  try {
    for (let from = version; from < SESSION_CHECKPOINT_VERSION; from++) {
      const upgrade = CHECKPOINT_UPGRADES[from];
      if (upgrade === undefined) refuse(`no upgrade from checkpoint version ${from}`);
      current = { ...upgrade(current), version: from + 1 };
    }
  } catch (error) {
    if (!(error instanceof CheckpointRefusal)) throw error;
    return { kind: "incompatible", detail: `checkpoint version ${version}: ${error.message}` };
  }
  if (!isCurrentCheckpoint(current)) {
    return { kind: "incompatible", detail: `checkpoint version ${version} is incomplete` };
  }
  return { kind: "current", checkpoint: current };
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
