import type { HarnessRuntimeActionDefinition } from "#harness/execute-tool.js";
import { getRuntimeActionRequestKey } from "#runtime/actions/keys.js";
import type { RuntimeActionRequest } from "#runtime/actions/types.js";
import type { JsonObject } from "#shared/json.js";
import type { CodeModeInterrupt } from "#shared/code-mode.js";

export const CODE_MODE_RUNTIME_ACTION_INTERRUPT_KIND = "eve.runtime-action";

export function isCodeModeRuntimeActionInterrupt(interrupt: unknown): boolean {
  return (
    isRecord(interrupt) &&
    isRecord(interrupt.payload) &&
    interrupt.payload.kind === CODE_MODE_RUNTIME_ACTION_INTERRUPT_KIND
  );
}

export function buildRuntimeActionFromInterrupt(
  interrupt: CodeModeInterrupt,
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

export function getRuntimeActionKeyFromInterrupt(interrupt: CodeModeInterrupt): string {
  return getRuntimeActionRequestKey(buildRuntimeActionFromInterrupt(interrupt));
}

function sanitizeCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
