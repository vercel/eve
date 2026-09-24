import type { ModelMessage, ToolSet, TypedToolCall } from "ai";

import { createActionResultEvent } from "#protocol/message.js";
import { resolveRuntimeActionResultsForCallIds } from "#runtime/actions/results.js";
import type {
  RuntimeActionRequest,
  RuntimeActionResult,
  RuntimeWorkflowTaskRequest,
} from "#shared/action-types.js";
import { markRuntimeWorkflowToolAction } from "#shared/action-types.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import { normalizeToolModelOutput } from "#harness/tool-model-output.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type {
  HarnessEmitFn,
  HarnessSession,
  HarnessToolMap,
  SessionStateMap,
  StepInput,
} from "#harness/types.js";

const PENDING_COORDINATION_BATCH_KEY = "eve.runtime.pendingCoordinationBatch";
type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;

/**
 * Serializable event coordinates for one pending coordination batch.
 *
 * Runtime action results are projected back onto the parent stream using the
 * same turn and step identity as the originating `actions.requested` batch.
 */
interface PendingCoordinationEventMetadata {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/**
 * Serializable pending coordination batch stored on `session.state`.
 *
 * Child ownership does not live here: the owner's task table records every
 * agent child before it starts and is the sole authority for continuing,
 * settling, and cancelling it.
 */
export interface PendingCoordinationBatch {
  /** Authored-tool and subagent workflow tasks pending coordination. */
  readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  readonly event: PendingCoordinationEventMetadata;
  readonly localFanoutSize?: number;
  readonly responseMessages: readonly ModelMessage[];
}

/**
 * Outcome of resolving a pending coordination batch.
 */
interface ResolvePendingCoordinationResult {
  readonly messages: ModelMessage[];
  readonly outcome: "continue" | "resolved" | "unresolved";
  readonly session: HarnessSession;
}

/** Returns the pending coordination batch stored on the session, if any. */
export function getPendingCoordinationBatch(
  state: SessionStateMap | undefined,
): PendingCoordinationBatch | undefined {
  const value = state?.[PENDING_COORDINATION_BATCH_KEY];

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const batch = value as PendingCoordinationBatch;

  if (
    !Array.isArray(batch.tasks) ||
    !Array.isArray(batch.responseMessages) ||
    typeof batch.event !== "object" ||
    batch.event === null
  ) {
    return undefined;
  }

  return batch;
}

/**
 * Returns true when the session is parked on pending task/control coordination.
 */
export function hasPendingCoordinationBatch(state: SessionStateMap | undefined): boolean {
  return getPendingCoordinationBatch(state) !== undefined;
}

export function clearPendingCoordinationBatch(session: HarnessSession): HarnessSession {
  if (session.state?.[PENDING_COORDINATION_BATCH_KEY] === undefined) {
    return session;
  }
  const state = { ...session.state };
  delete state[PENDING_COORDINATION_BATCH_KEY];
  return { ...session, state: Object.keys(state).length > 0 ? state : undefined };
}

/**
 * Stores one pending coordination batch on the session.
 */
export function setPendingCoordinationBatch(input: {
  readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  readonly event: PendingCoordinationEventMetadata;
  readonly localFanoutSize?: number;
  readonly responseMessages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): HarnessSession {
  assertUniqueCoordinationCallIds(input.tasks);
  const state = { ...input.session.state };
  state[PENDING_COORDINATION_BATCH_KEY] = {
    tasks: [...input.tasks],
    event: input.event,
    localFanoutSize: input.localFanoutSize,
    responseMessages: [...input.responseMessages],
  } satisfies PendingCoordinationBatch;

  return { ...input.session, state };
}

/** Rejects a batch before any result or side effect can bind ambiguously by call id. */
export function assertUniqueCoordinationCallIds(
  requests: readonly { readonly callId: string }[],
): void {
  const seen = new Set<string>();
  for (const request of requests) {
    if (seen.has(request.callId)) {
      throw new Error(`Coordination batch contains duplicate callId "${request.callId}".`);
    }
    seen.add(request.callId);
  }
}

/**
 * Returns the ordered results for the current pending coordination batch when
 * every request has a matching result. Unknown and duplicate results
 * are ignored.
 */
function resolveReadyCoordinationResults(input: {
  readonly results: readonly RuntimeActionResult[];
  readonly session: HarnessSession;
}): RuntimeActionResult[] | undefined {
  const batch = getPendingCoordinationBatch(input.session.state);

  if (batch === undefined) {
    return undefined;
  }

  return resolveResultsForCoordinationBatch({
    batch,
    results: input.results,
    state: input.session.state,
  });
}

function resolveResultsForCoordinationBatch(input: {
  readonly batch: PendingCoordinationBatch;
  readonly results: readonly RuntimeActionResult[];
  readonly state: SessionStateMap | undefined;
}): RuntimeActionResult[] | undefined {
  return resolveRuntimeActionResultsForCallIds({
    pendingCallIds: input.batch.tasks.map((request) => request.callId),
    results: input.results,
  });
}

/**
 * Resolves one pending coordination batch back into model history.
 *
 * When all expected runtime action results are present, this appends the
 * stored assistant tool-call messages plus synthesized tool-result messages to
 * history, clears the pending batch, and emits `action.result` events back
 * onto the parent stream.
 */
export async function resolvePendingCoordination(input: {
  readonly emit?: HarnessEmitFn;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
  /** Definitions whose `toModelOutput` projects a workflow tool's result for the model. */
  readonly tools?: HarnessToolMap;
}): Promise<ResolvePendingCoordinationResult> {
  const batch = getPendingCoordinationBatch(input.session.state);

  if (batch === undefined) {
    return {
      messages: [...input.session.history],
      outcome: "continue",
      session: input.session,
    };
  }

  const readyResults = resolveReadyCoordinationResults({
    results: input.stepInput?.runtimeActionResults ?? [],
    session: input.session,
  });

  if (readyResults === undefined) {
    return {
      messages: [...input.session.history],
      outcome: "unresolved",
      session: input.session,
    };
  }

  const nextSession = clearPendingCoordinationBatch(input.session);

  if (input.emit !== undefined) {
    for (const result of readyResults) {
      await input.emit(
        createActionResultEvent({
          result,
          sequence: batch.event.sequence,
          stepIndex: batch.event.stepIndex,
          turnId: batch.event.turnId,
        }),
      );
    }
  }

  const toolResults: ToolResultPart[] = [];
  for (const result of readyResults) {
    switch (result.kind) {
      case "load-skill-result":
        toolResults.push({
          output: toToolResultOutput(result),
          toolCallId: result.callId,
          toolName: "load_skill",
          type: "tool-result",
        });
        continue;
      case "subagent-result":
        toolResults.push({
          output: toToolResultOutput(result),
          toolCallId: result.callId,
          toolName: result.subagentName,
          type: "tool-result",
        });
        continue;
      case "tool-result":
        toolResults.push({
          output: await projectToolResultOutput(result, input.tools?.get(result.toolName)),
          toolCallId: result.callId,
          toolName: result.toolName,
          type: "tool-result",
        });
        continue;
    }

    throw new Error(`Unsupported runtime action result kind "${String(result)}".`);
  }

  const messages = [...nextSession.history, ...batch.responseMessages];

  if (toolResults.length > 0) {
    messages.push({
      content: toolResults,
      role: "tool",
    });
  }
  return {
    messages,
    outcome: "resolved",
    session: nextSession,
  };
}

/**
 * Projects one AI SDK tool call into the eve runtime-action contract.
 */
export function createRuntimeActionRequestFromToolCall(input: {
  readonly toolCall: TypedToolCall<ToolSet>;
  readonly tools: HarnessToolMap;
}): RuntimeActionRequest {
  const definition = input.tools.get(input.toolCall.toolName);
  const toolInput = resolveToolCallInputObject(input.toolCall.input, {
    callId: input.toolCall.toolCallId,
    toolName: input.toolCall.toolName,
  });
  if (definition?.frameworkAction === "load-skill") {
    return { callId: input.toolCall.toolCallId, input: toolInput, kind: "load-skill" };
  }
  const action: RuntimeActionRequest = {
    callId: input.toolCall.toolCallId,
    input: toolInput,
    kind: "tool-call",
    toolName: input.toolCall.toolName,
  };
  return definition?.workflowId === undefined ? action : markRuntimeWorkflowToolAction(action);
}

/** Projects one deferred harness tool call into a workflow task request. */
export function createCoordinationRequestFromToolCall(input: {
  readonly toolCall: TypedToolCall<ToolSet>;
  readonly tools: HarnessToolMap;
}): RuntimeWorkflowTaskRequest {
  const definition = input.tools.get(input.toolCall.toolName);
  const inputObject = resolveToolCallInputObject(input.toolCall.input, {
    callId: input.toolCall.toolCallId,
    toolName: input.toolCall.toolName,
  });
  if (definition?.workflowId !== undefined) {
    return {
      callId: input.toolCall.toolCallId,
      executeInput: definition.executeInput?.(inputObject),
      input: inputObject,
      kind: "workflow-task",
      toolName: input.toolCall.toolName,
      workflowId: definition.workflowId,
    };
  }
  throw new Error(`Deferred tool "${input.toolCall.toolName}" has no workflow task.`);
}

/**
 * Coerces an AI SDK tool-call `input` into the runtime-action `JsonObject`
 * contract, throwing a `TypeError` (with the original as `cause`) that names
 * the offending tool when the payload is not a JSON object.
 *
 * String inputs are parsed as JSON first: the model protocol carries tool
 * arguments as text, and provider-executed tool calls can surface that raw
 * string — or an empty string when the model sends no arguments.
 */
export function resolveToolCallInputObject(
  value: unknown,
  context: { readonly callId: string; readonly toolName: string },
): JsonObject {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value === "string" && value.trim() === "") {
    return {};
  }

  try {
    return parseJsonObject(typeof value === "string" ? parseJsonStringInput(value) : value);
  } catch (error) {
    // This module is bundled into the workflow driver body, which cannot
    // import the logger, so enrich the error (and keep the original as
    // `cause`) for whatever catch site does the logging.
    const detail = error instanceof Error ? error.message : String(error);
    throw new TypeError(
      `Failed to parse tool-call arguments for "${context.toolName}" (${context.callId}): ${detail}`,
      { cause: error },
    );
  }
}

function parseJsonStringInput(value: string): unknown {
  return JSON.parse(value);
}

/** Errors bypass `toModelOutput`, as they do for local execution. */
async function projectToolResultOutput(
  result: Extract<RuntimeActionResult, { kind: "tool-result" }>,
  definition: HarnessToolDefinition | undefined,
): Promise<ToolResultPart["output"]> {
  if (result.isError === true || definition?.toModelOutput === undefined) {
    return toToolResultOutput(result);
  }
  return normalizeToolModelOutput({
    output: await definition.toModelOutput(result.output),
    toolCallId: result.callId,
    toolName: result.toolName,
  });
}

function toToolResultOutput(result: RuntimeActionResult): ToolResultPart["output"] {
  if (typeof result.output === "string") {
    if (result.isError === true) {
      return {
        type: "error-text",
        value: result.output,
      };
    }

    return {
      type: "text",
      value: result.output,
    };
  }

  if (result.isError === true) {
    return {
      type: "error-json",
      value: toMutableJsonValue(result.output),
    };
  }

  return {
    type: "json",
    value: toMutableJsonValue(result.output),
  };
}

function toMutableJsonValue(value: RuntimeActionResult["output"]): MutableJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toMutableJsonValue(item));
  }

  const next: Record<string, MutableJsonValue> = {};

  for (const [key, item] of Object.entries(value)) {
    next[key] = toMutableJsonValue(item);
  }

  return next;
}

type MutableJsonValue =
  | null
  | boolean
  | number
  | string
  | MutableJsonValue[]
  | { [key: string]: MutableJsonValue };
