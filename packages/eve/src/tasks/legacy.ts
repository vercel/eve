import type { SessionStateMap } from "#harness/types.js";
import type { JsonObject } from "#shared/json.js";
import type { RecoveredTaskFields } from "#tasks/record.js";

// Sessions are not migrated across the background tasks rewrite. A session
// from an earlier release may still hold background runs in the workflow
// tool run registry that release wrote; each working one is reported once as
// `STATE_LOST`, and the registry is removed with the other unreadable records.
// Delete this module, and its uses in `table.ts`, one release after the
// rewrite ships: by then every session that ran has dropped the registry.

/** Session state key of the workflow tool run registry releases before the task table wrote. */
export const LEGACY_WORKFLOW_TOOL_RUNS_STATE_KEY = "eve.workflowTool";

const LEGACY_REASON = "task state from an earlier eve release";

/** A background task an earlier release left working, as an unreadable record reports it. */
export type LegacyTaskLoss = RecoveredTaskFields & { readonly reason: string };

/** The working background runs an earlier release's registry still holds. */
export function readLegacyTaskLosses(state: SessionStateMap | undefined): LegacyTaskLoss[] {
  const registry = state?.[LEGACY_WORKFLOW_TOOL_RUNS_STATE_KEY];
  const runs =
    typeof registry === "object" && registry !== null && !Array.isArray(registry)
      ? (registry as { readonly runs?: unknown }).runs
      : undefined;
  if (!Array.isArray(runs)) return [];
  return runs.flatMap((run: unknown) => {
    const loss = readLegacyRun(run);
    return loss === undefined ? [] : [loss];
  });
}

/** Removes the registry once its losses are reported. */
export function dropLegacyTaskState(
  state: SessionStateMap | undefined,
): SessionStateMap | undefined {
  if (state?.[LEGACY_WORKFLOW_TOOL_RUNS_STATE_KEY] === undefined) return state;
  const next = { ...state };
  delete next[LEGACY_WORKFLOW_TOOL_RUNS_STATE_KEY];
  return Object.keys(next).length === 0 ? undefined : next;
}

function readLegacyRun(value: unknown): LegacyTaskLoss | undefined {
  if (!isRecord(value) || value.lifetime !== "session" || !isRecord(value.task)) return undefined;
  const { task } = value;
  // A run with an outcome already reported it to the model.
  if (task.outcome !== undefined) return undefined;
  const metadata = isRecord(task.metadata) ? task.metadata : {};
  const name = nonEmpty(metadata.name) ?? nonEmpty(value.toolName);
  const id = nonEmpty(task.taskId);
  if (id === undefined || name === undefined) return undefined;
  const loss: { -readonly [K in keyof LegacyTaskLoss]: LegacyTaskLoss[K] } = {
    generation: 1,
    id,
    kind: metadata.kind === "tool" ? "workflow" : "agent",
    mode: "background",
    name,
    reason: LEGACY_REASON,
  };
  const callId = nonEmpty(value.callId);
  if (callId !== undefined) loss.callId = callId;
  const auth = isRecord(task.dispatchContext) ? task.dispatchContext.auth : undefined;
  if (isRecord(auth) && isRecord(auth.current)) {
    loss.creator = { auth: auth.current as JsonObject };
  }
  return loss;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
