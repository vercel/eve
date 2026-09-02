import { getPendingDispatchActionKey } from "#runtime/actions/keys.js";
import type { PendingDispatchAction } from "#shared/dispatch-action.js";
import type { JsonObject } from "#shared/json.js";
import {
  getWorkflowSandboxPendingInterrupts,
  type WorkflowSandboxInterrupt,
} from "#shared/workflow-sandbox.js";
import type { PreparedDispatchTarget } from "#tools/behavior.js";

export const WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND = "eve.workflow-runtime-action";

export function isWorkflowRuntimeActionInterrupt(interrupt: unknown): boolean {
  return (
    isRecord(interrupt) &&
    isRecord(interrupt.payload) &&
    interrupt.payload.kind === WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND
  );
}

export function buildRuntimeActionFromWorkflowInterrupt(
  interrupt: WorkflowSandboxInterrupt,
): PendingDispatchAction {
  const raw = interrupt.payload as Record<string, unknown>;
  const dispatchTarget = raw.dispatchTarget as PreparedDispatchTarget;
  const toolInput = raw.toolInput as JsonObject;
  const toolName = raw.toolName as string;
  const interruptId = "interruptId" in interrupt ? String(interrupt.interruptId) : "";
  const callId = sanitizeCallId(`${toolName}_${interruptId}`);

  if (
    dispatchTarget.kind === "self-agent-call" ||
    dispatchTarget.kind === "subagent-call" ||
    dispatchTarget.kind === "remote-agent-call"
  ) {
    return {
      callId,
      description: "",
      input: toolInput,
      target: dispatchTarget,
      toolName,
    };
  }

  // Dynamic workflows only interrupt on delegation tools; task controls
  // never enter a workflow sandbox.
  throw new Error(`Workflow runtime actions cannot carry "${dispatchTarget.kind}" tools.`);
}

/** Returns every pending runtime-action interrupt in deterministic request order. */
export function getWorkflowRuntimeActionInterrupts(
  interrupt: WorkflowSandboxInterrupt,
): WorkflowSandboxInterrupt[] {
  return getWorkflowSandboxPendingInterrupts(interrupt).filter(isWorkflowRuntimeActionInterrupt);
}

export function buildRuntimeActionsFromWorkflowInterrupt(
  interrupt: WorkflowSandboxInterrupt,
): PendingDispatchAction[] {
  return getWorkflowRuntimeActionInterrupts(interrupt).map((pending) =>
    buildRuntimeActionFromWorkflowInterrupt(pending),
  );
}

export function getRuntimeActionKeysFromWorkflowInterrupt(
  interrupt: WorkflowSandboxInterrupt,
): string[] {
  return buildRuntimeActionsFromWorkflowInterrupt(interrupt).map(getPendingDispatchActionKey);
}

function sanitizeCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
