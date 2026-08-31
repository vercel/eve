import type { HarnessRuntimeActionDefinition } from "#harness/execute-tool.js";
import { getRuntimeActionRequestKey } from "#runtime/actions/keys.js";
import type { RuntimeActionRequest } from "#shared/action-types.js";
import type { JsonObject } from "#shared/json.js";
import {
  getWorkflowSandboxPendingInterrupts,
  type WorkflowSandboxInterrupt,
} from "#shared/workflow-sandbox.js";

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
): RuntimeActionRequest {
  const raw = interrupt.payload as Record<string, unknown>;
  const runtimeAction = raw.runtimeAction as HarnessRuntimeActionDefinition;
  const toolInput = raw.toolInput as JsonObject;
  const toolName = raw.toolName as string;
  const interruptId = "interruptId" in interrupt ? String(interrupt.interruptId) : "";
  const callId = sanitizeCallId(`${toolName}_${interruptId}`);

  if (runtimeAction.kind === "remote-agent-call") {
    return {
      callId,
      description: "",
      input: toolInput,
      kind: "remote-agent-call",
      name: toolName,
      nodeId: runtimeAction.nodeId,
      remoteAgentName: runtimeAction.remoteAgentName ?? toolName,
    };
  }

  if (runtimeAction.kind === "subagent-call") {
    return {
      callId,
      description: "",
      input: toolInput,
      kind: "subagent-call",
      name: toolName,
      nodeId: runtimeAction.nodeId,
      subagentName: runtimeAction.subagentName,
    };
  }

  // Dynamic workflows only interrupt on delegation tools; task controls
  // never enter a workflow sandbox.
  throw new Error(`Workflow runtime actions cannot carry "${runtimeAction.kind}" tools.`);
}

/** Returns every pending runtime-action interrupt in deterministic request order. */
export function getWorkflowRuntimeActionInterrupts(
  interrupt: WorkflowSandboxInterrupt,
): WorkflowSandboxInterrupt[] {
  return getWorkflowSandboxPendingInterrupts(interrupt).filter(isWorkflowRuntimeActionInterrupt);
}

export function buildRuntimeActionsFromWorkflowInterrupt(
  interrupt: WorkflowSandboxInterrupt,
): RuntimeActionRequest[] {
  return getWorkflowRuntimeActionInterrupts(interrupt).map((pending) =>
    buildRuntimeActionFromWorkflowInterrupt(pending),
  );
}

export function getRuntimeActionKeysFromWorkflowInterrupt(
  interrupt: WorkflowSandboxInterrupt,
): string[] {
  return buildRuntimeActionsFromWorkflowInterrupt(interrupt).map(getRuntimeActionRequestKey);
}

/** Reads pending calls only to terminate continuations parked by the retired v1 engine. */
export function getLegacyWorkflowRuntimeActionInterrupts(
  interrupt: WorkflowSandboxInterrupt,
): WorkflowSandboxInterrupt[] {
  const ledger: unknown = Reflect.get(interrupt.continuation, "ledger");
  if (!Array.isArray(ledger)) return [];

  return ledger.flatMap((value) => {
    if (!isRecord(value) || value.kind !== "tool" || value.status !== "interrupted") return [];
    if (
      typeof value.interruptId !== "string" ||
      typeof value.toolCallId !== "string" ||
      typeof value.name !== "string" ||
      !isRecord(value.interruptPayload) ||
      value.interruptPayload.kind !== WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND
    ) {
      return [];
    }

    let toolInput: unknown;
    if (typeof value.inputJson === "string" && value.inputJson !== "") {
      toolInput = JSON.parse(value.inputJson);
    }

    return [
      {
        continuation: interrupt.continuation,
        input: toolInput,
        interruptId: value.interruptId,
        outerToolCallId: interrupt.outerToolCallId,
        payload: {
          ...value.interruptPayload,
          kind: WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND,
        },
        toolCallId: value.toolCallId,
        toolName: value.name,
        type: "code-mode-interrupt" as const,
      },
    ];
  });
}

export function buildLegacyRuntimeActionsFromWorkflowInterrupt(
  interrupt: WorkflowSandboxInterrupt,
): RuntimeActionRequest[] {
  return getLegacyWorkflowRuntimeActionInterrupts(interrupt).map((pending) =>
    buildRuntimeActionFromWorkflowInterrupt(pending),
  );
}

export function getLegacyRuntimeActionKeysFromWorkflowInterrupt(
  interrupt: WorkflowSandboxInterrupt,
): string[] {
  return buildLegacyRuntimeActionsFromWorkflowInterrupt(interrupt).map(getRuntimeActionRequestKey);
}

function sanitizeCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
