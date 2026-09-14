import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { JsonObject } from "#shared/json.js";
import {
  getWorkflowSandboxPendingInterrupts,
  type WorkflowSandboxInterrupt,
} from "#shared/workflow-sandbox.js";

export const WORKFLOW_TASK_INTERRUPT_KIND = "eve.workflow-task";

interface SerializedWorkflowTaskDefinition {
  readonly executeInput?: import("#shared/json.js").JsonValue;
  readonly nodeId?: string;
  readonly resultKind?: "subagent" | "tool";
  readonly workflowId: string;
}

export function isWorkflowTaskInterrupt(interrupt: unknown): boolean {
  return (
    isRecord(interrupt) &&
    isRecord(interrupt.payload) &&
    interrupt.payload.kind === WORKFLOW_TASK_INTERRUPT_KIND
  );
}

export function buildWorkflowTaskFromInterrupt(
  interrupt: WorkflowSandboxInterrupt,
): RuntimeWorkflowTaskRequest {
  const raw = interrupt.payload as Record<string, unknown>;
  const task = raw.task as SerializedWorkflowTaskDefinition | undefined;
  const toolInput = raw.toolInput as JsonObject;
  const toolName = raw.toolName as string;
  const interruptId = "interruptId" in interrupt ? String(interrupt.interruptId) : "";
  const callId = sanitizeCallId(`${toolName}_${interruptId}`);

  if (task === undefined || typeof task.workflowId !== "string") {
    throw new Error("Workflow delegation interrupts require a workflow task.");
  }
  const result: {
    -readonly [K in keyof RuntimeWorkflowTaskRequest]: RuntimeWorkflowTaskRequest[K];
  } = {
    callId,
    executeInput: task.executeInput,
    input: toolInput,
    kind: "workflow-task",
    resultKind: task.resultKind,
    toolName,
    workflowId: task.workflowId,
  };
  if (task.nodeId !== undefined) result.nodeId = task.nodeId;
  return result;
}

/** Returns every pending workflow-task interrupt in deterministic ledger order. */
export function getWorkflowTaskInterrupts(
  interrupt: WorkflowSandboxInterrupt,
): WorkflowSandboxInterrupt[] {
  return getWorkflowSandboxPendingInterrupts(interrupt).filter(isWorkflowTaskInterrupt);
}

export function buildWorkflowTasksFromInterrupt(
  interrupt: WorkflowSandboxInterrupt,
): RuntimeWorkflowTaskRequest[] {
  return getWorkflowTaskInterrupts(interrupt).map((pending) =>
    buildWorkflowTaskFromInterrupt(pending),
  );
}

export function getWorkflowTaskCallIds(interrupt: WorkflowSandboxInterrupt): string[] {
  return buildWorkflowTasksFromInterrupt(interrupt).map((task) => task.callId);
}

function sanitizeCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
