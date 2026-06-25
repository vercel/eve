import type { HarnessRuntimeActionDefinition } from "#harness/execute-tool.js";
import { getRuntimeActionRequestKey } from "#runtime/actions/keys.js";
import type { RuntimeActionRequest } from "#runtime/actions/types.js";
import type { JsonObject } from "#shared/json.js";
import type { WorkflowSandboxInterrupt } from "#shared/workflow-sandbox.js";

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

/** Returns every pending runtime-action interrupt in deterministic ledger order. */
export function getWorkflowRuntimeActionInterrupts(
  interrupt: WorkflowSandboxInterrupt,
): WorkflowSandboxInterrupt[] {
  return interrupt.continuation.ledger.flatMap((entry) => {
    if (
      entry.kind !== "tool" ||
      entry.status !== "interrupted" ||
      entry.interruptPayload.kind !== WORKFLOW_RUNTIME_ACTION_INTERRUPT_KIND
    ) {
      return [];
    }

    return [
      {
        continuation: interrupt.continuation,
        input: entry.inputJson === "" ? undefined : JSON.parse(entry.inputJson),
        interruptId: entry.interruptId,
        outerToolCallId: interrupt.continuation.outerToolCallId,
        payload: entry.interruptPayload,
        toolCallId: entry.toolCallId,
        toolName: entry.name,
        type: "code-mode-interrupt" as const,
      },
    ];
  });
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

function sanitizeCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
