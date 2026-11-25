import { requireClearance, type Clearance } from "#harness/clearance.js";
import { sha256 } from "#runtime-env/sha256.js";
import { toHex } from "#shared/bytes.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";

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

export function hasWorkflowAdmission(task: RuntimeWorkflowTaskRequest): boolean {
  return task.admission?.callId === task.callId && task.admission.fingerprint === fingerprint(task);
}

function fingerprint(task: RuntimeWorkflowTaskRequest): string {
  return toHex(
    sha256(
      stableJson([
        task.callId,
        task.toolName,
        task.workflowId,
        task.entry,
        task.input,
        task.executeInput,
        task.clearedBy,
      ]),
    ),
  );
}

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
