import type { SessionEvent } from "#protocol/session-event.js";
import type { Cause, ErrorInfo, JsonValue, Scope } from "#protocol/session-events/envelope.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import type { Capability, CallOwner, ClearedBy } from "#protocol/session-events/families/call.js";
import type { RuntimeActionRequest, RuntimeActionResult } from "#shared/action-types.js";
import { callOutcomeOf } from "#harness/call-outcome.js";

// The facts for one call, built where the call streams and runs: what the model asked for, that
// it started, and how it settled. Calls never reach the wire any other way.

/** What a call invokes: a tool, an agent, or the skill it loads, with its label. */
export function capabilityOf(action: RuntimeActionRequest, title?: string): Capability {
  const capability: { -readonly [K in keyof Capability]: Capability[K] } =
    action.kind === "load-skill"
      ? { kind: "skill", name: action.name }
      : action.kind === "subagent-call" || action.kind === "remote-agent-call"
        ? { kind: "agent", name: action.name }
        : { kind: "tool", name: action.toolName };
  if (title !== undefined) capability.title = title;
  return capability;
}

/** The model asked for a call. */
export function callRequested(input: {
  readonly action: RuntimeActionRequest;
  readonly owner: CallOwner;
  readonly scope?: Scope;
  readonly title?: string;
  readonly inputError?: ErrorInfo;
}): FactOf<"call.requested"> {
  const { action } = input;
  const data: {
    -readonly [K in keyof FactOf<"call.requested">["data"]]: FactOf<"call.requested">["data"][K];
  } = {
    callId: action.callId,
    capability: capabilityOf(action, input.title),
    owner: input.owner,
  };
  if (input.inputError === undefined) data.input = toJsonValue(action.input);
  else data.inputError = input.inputError;
  return input.scope === undefined
    ? { data, type: "call.requested" }
    : { data, scope: input.scope, type: "call.requested" };
}

/** A call was cleared and began running. */
export function callStarted(
  callId: string,
  options: { readonly clearedBy?: ClearedBy; readonly scope?: Scope } = {},
): FactOf<"call.started"> {
  const data: {
    -readonly [K in keyof FactOf<"call.started">["data"]]: FactOf<"call.started">["data"][K];
  } = { callId };
  if (options.clearedBy !== undefined) data.clearedBy = options.clearedBy;
  return options.scope === undefined
    ? { data, type: "call.started" }
    : { data, scope: options.scope, type: "call.started" };
}

/** A call settled from its runtime result: failed if the result says so, otherwise completed. */
export function callSettledFrom(
  result: RuntimeActionResult,
  options: {
    readonly scope?: Scope;
    readonly title?: string;
    readonly rejected?: boolean;
    readonly cause?: Cause;
  } = {},
): FactOf<"call.settled"> {
  const { error, outcome } = callOutcomeOf(result);
  // Rejection is an explicit adjudication, never inferred from an output's error code.
  // Fresh policy denials and failures inside a tool remain failed unless the caller says otherwise.
  const rejected = options.rejected === true;
  const data: {
    -readonly [K in keyof FactOf<"call.settled">["data"]]: FactOf<"call.settled">["data"][K];
  } = {
    callId: result.callId,
    outcome: rejected ? "rejected" : outcome,
  };
  if (result.output !== undefined) data.output = toJsonValue(result.output);
  if (error !== undefined) data.error = error;
  if (options.cause !== undefined) data.cause = options.cause;
  else if (rejected) data.cause = { policy: "approval" };
  if (options.title !== undefined) data.title = options.title;
  return options.scope === undefined
    ? { data, type: "call.settled" }
    : { data, scope: options.scope, type: "call.settled" };
}

/** A call's partial output, as progress. */
export function callProgress(callId: string, output: unknown, title?: string): SessionEvent {
  const data: { callId: string; output: JsonValue; title?: string } = {
    callId,
    output: toJsonValue(output),
  };
  if (title !== undefined) data.title = title;
  return { data, type: "call.progress" };
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
