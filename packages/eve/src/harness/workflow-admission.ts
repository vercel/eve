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

function fingerprint(task: RuntimeWorkflowTaskRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
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
