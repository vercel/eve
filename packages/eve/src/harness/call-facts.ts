import type { SessionEvent } from "#protocol/session-event.js";
import type { Cause, ErrorInfo, JsonValue } from "#protocol/session-events/envelope.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import type {
  Capability,
  CapabilityKind,
  CallOwner,
  ClearedBy,
} from "#protocol/session-events/families/call.js";
import { isTaskControlTool } from "#protocol/task-tools.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { SKILL_ENTRY_NAME } from "#protocol/catalog-tools.js";
import type { RuntimeActionRequest, RuntimeActionResult } from "#shared/action-types.js";
import { callOutcomeOf } from "#harness/call-outcome.js";
import { defined, fact } from "#harness/facts.js";

// The facts for one call, built where the call streams and runs: what the model asked for, that
// it started, and how it settled. Calls never reach the wire any other way.

/** What a call invokes: a tool, an agent, the skill it loads, or a task control, with its label. */
export function capabilityOf(action: RuntimeActionRequest, label?: string): Capability {
  const capability: Capability =
    action.kind === "load-skill"
      ? { kind: "skill", name: action.name }
      : action.kind === "subagent-call"
        ? { kind: "agent", name: action.name }
        : action.kind === "remote-agent-call"
          ? { kind: "agent", name: action.name, remote: true }
          : { kind: toolKind(action.toolName), name: action.toolName };
  return label === undefined ? capability : { ...capability, label };
}

/** What a call to an entry invokes, as its input starts streaming. */
export function announcedKind(
  name: string,
  definition: Pick<HarnessToolDefinition, "behavior"> | undefined,
): CapabilityKind {
  if (name === SKILL_ENTRY_NAME) return "skill";
  const handling = definition?.behavior?.handling;
  if (handling?.kind === "dispatch" && handling.target.kind !== "workflow-tool-call")
    return "agent";
  return toolKind(name);
}

function toolKind(name: string): CapabilityKind {
  return isTaskControlTool(name) ? "control" : "tool";
}

/** The model asked for a call. */
export function callRequested(input: {
  readonly action: RuntimeActionRequest;
  readonly owner: CallOwner;
  readonly label?: string;
  readonly inputError?: ErrorInfo;
}): FactOf<"call.requested"> {
  const { action, inputError } = input;
  return fact("call.requested", {
    callId: action.callId,
    capability: capabilityOf(action, input.label),
    input: inputError === undefined ? toJsonValue(action.input) : undefined,
    inputError,
    owner: input.owner,
  });
}

/** A call was cleared and began running. */
export function callStarted(
  callId: string,
  options: { readonly clearedBy?: ClearedBy } = {},
): FactOf<"call.started"> {
  return fact("call.started", { callId, clearedBy: options.clearedBy });
}

/** A call settled from its runtime result: failed if the result says so, otherwise completed. */
export function callSettledFrom(
  result: RuntimeActionResult,
  options: {
    readonly label?: string;
    readonly rejected?: boolean;
    readonly cause?: Cause;
  } = {},
): FactOf<"call.settled"> {
  const { error, outcome } = callOutcomeOf(result);
  // Rejection is an explicit adjudication, never inferred from an output's error code.
  // Fresh policy denials and failures inside a tool remain failed unless the caller says otherwise.
  const rejected = options.rejected === true;
  return fact("call.settled", {
    callId: result.callId,
    cause: options.cause ?? (rejected ? { policy: "approval" } : undefined),
    error,
    outcome: rejected ? "rejected" : outcome,
    output: result.output === undefined ? undefined : toJsonValue(result.output),
    label: options.label,
  });
}

/** A call's partial output, as progress. */
export function callProgress(callId: string, output: unknown, label?: string): SessionEvent {
  return { data: defined({ callId, output: toJsonValue(output), label }), type: "call.progress" };
}

/** A value as the wire carries it: JSON, with anything else as its string form. */
export function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}
