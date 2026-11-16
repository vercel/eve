import { createHash } from "node:crypto";

import { requireClearance, type Clearance } from "#harness/clearance.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";

/** Carries a gate decision across the durable handoff without treating `clearedBy` as authority. */
export function admitWorkflowTask(
  task: RuntimeWorkflowTaskRequest,
  clearance: Clearance,
): RuntimeWorkflowTaskRequest {
  requireClearance(clearance, task.callId);
  const allowed = { ...task, clearedBy: clearance.clearedBy };
  return {
    ...allowed,
    admission: { callId: clearance.callId, fingerprint: fingerprint(allowed) },
  };
}

/** A legacy or changed request has no proof for the work it is about to start. */
export function hasWorkflowAdmission(task: RuntimeWorkflowTaskRequest): boolean {
  return task.admission?.callId === task.callId && task.admission.fingerprint === fingerprint(task);
}

/**
 * A digest of what the gate admitted: the call and everything its run would start with. It isn't
 * keyed, so it proves a request matches what the gate admitted, not who wrote it; anything that
 * can write the persisted request could recompute it. That covers what this check is for: stale
 * requests, input changed after approval, and paths that skip the gate. Fields serialize with
 * sorted keys, so a serializer that reorders `entry` or `input` keys can't refuse a valid call.
 */
function fingerprint(task: RuntimeWorkflowTaskRequest): string {
  return createHash("sha256")
    .update(
      stableJson([
        task.callId,
        task.toolName,
        task.workflowId,
        task.entry,
        task.input,
        task.executeInput,
        task.clearedBy,
      ]),
    )
    .digest("hex");
}

/** `JSON.stringify` with every object's keys sorted. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) =>
    field === null || typeof field !== "object" || Array.isArray(field)
      ? field
      : Object.fromEntries(
          Object.keys(field)
            .sort()
            .map((key) => [key, (field as Record<string, unknown>)[key]]),
        ),
  );
}
