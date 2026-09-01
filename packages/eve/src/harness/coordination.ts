import type { ModelMessage, ToolSet, TypedToolCall } from "ai";

import { createActionResultEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";
import { resolveRuntimeActionResultsForCallIds } from "#runtime/actions/results.js";
import type {
  RuntimeActionRequest,
  RuntimeActionResult,
  RuntimeToolCallActionRequest,
  RuntimeWorkflowTaskRequest,
} from "#shared/action-types.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import type { AgentTurnOutcome } from "#shared/agent-turn-outcome.js";
import { findRunningAgentHandle, isResultBoundToRunningHandle } from "#harness/handles/query.js";
import { settleAgentTurn } from "#harness/handles/transitions.js";
import {
  clearProxyInputRequestsForChild,
  clearProxyInputRequestsWhere,
} from "#harness/proxy-input-requests.js";
import { findWorkflowToolRun, removeWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import { normalizeToolModelOutput } from "#harness/tool-model-output.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  accumulateSessionUsage,
  getTurnUsageState,
  setTurnUsageState,
} from "#harness/turn-tag-state.js";
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
 * Lifecycle outcome from a subagent result. Only `child`-origin results
 * carry one; parent-synthesized dispatch failures never do, and their type
 * omits the field entirely.
 */
function readSubagentResultOutcome(
  result: Extract<RuntimeActionResult, { kind: "subagent-result" }>,
): AgentTurnOutcome | undefined {
  return result.origin === "child" ? result.outcome : undefined;
}

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
 * Child ownership does not live here: the agent handle store records every
 * dispatched child (from before its start side effect) and is the sole
 * authority for continuing, settling, and cancelling children.
 */
export interface PendingCoordinationBatch {
  /** Framework task controls deferred to the turn owner. */
  readonly runtimeActions: readonly RuntimeToolCallActionRequest[];
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
    !Array.isArray(batch.runtimeActions) ||
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
  readonly runtimeActions: readonly RuntimeToolCallActionRequest[];
  readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  readonly event: PendingCoordinationEventMetadata;
  readonly localFanoutSize?: number;
  readonly responseMessages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): HarnessSession {
  assertUniqueCoordinationCallIds([...input.runtimeActions, ...input.tasks]);
  const state = { ...input.session.state };
  state[PENDING_COORDINATION_BATCH_KEY] = {
    runtimeActions: [...input.runtimeActions],
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
    pendingCallIds: [...input.batch.runtimeActions, ...input.batch.tasks].map(
      (request) => request.callId,
    ),
    results: input.results.filter((result) => isResultBoundToRunningHandle(input.state, result)),
  });
}

/**
 * Resolves one pending coordination batch back into model history.
 *
 * When all expected runtime action results are present, this appends the
 * stored assistant tool-call messages plus synthesized tool-result messages to
 * history, clears the pending batch, and emits `subagent.completed` and
 * `action.result` events back onto the parent stream.
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

  if (input.emit !== undefined) {
    for (const result of readyResults) {
      if (result.kind === "subagent-result" && result.isError !== true) {
        const backgroundTask = readBackgroundTaskReceipt(result);
        const data = {
          callId: result.callId,
          output: typeof result.output === "string" ? result.output : JSON.stringify(result.output),
          subagentName: result.subagentName,
        };
        await input.emit({
          data: backgroundTask === undefined ? data : { ...data, backgroundTask },
          type: "subagent.completed",
        } satisfies Extract<UnstampedMessageStreamEvent, { type: "subagent.completed" }>);
      }

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

  // Settle each bound child result against its running handle from the
  // outcome the child engine reported: `parked` keeps the handle (the child
  // is idle and resumable), `terminal` deletes it. Before a terminal
  // deletion the proxy-input entry keyed by the child's continuation token
  // is cleared (the handle is the only record of that token) so future
  // deliveries don't route responses to a dead child.
  let nextSession: HarnessSession = input.session;
  for (const result of readyResults) {
    // Dispatch failures never settle handles: the dispatch step already
    // rejected (deleted) the handle when it synthesized the failure.
    if (result.kind !== "subagent-result" || result.origin !== "child") {
      continue;
    }
    // A background receipt confirms task admission, not child-turn settlement.
    // The task snapshot later carries the actual parked/terminal outcome.
    if (readBackgroundTaskReceipt(result) !== undefined) {
      continue;
    }
    const handle = findRunningAgentHandle(nextSession.state, { callId: result.callId });
    if (handle === undefined) {
      continue;
    }
    const outcome = readSubagentResultOutcome(result);
    if (outcome === undefined) {
      continue;
    }
    if (outcome.kind === "terminal" && "continuationToken" in handle.address) {
      nextSession = clearProxyInputRequestsForChild(nextSession, handle.address.continuationToken);
    }
    const settled = settleAgentTurn(nextSession, {
      operationId: handle.operation.id,
      outcome,
    });
    if (settled.kind === "settled") {
      nextSession = settled.session;
    }
  }

  // Drop a finished run's unanswered requests so a late click cannot reach it.
  for (const result of readyResults) {
    if (result.kind !== "tool-result") continue;
    const record = findWorkflowToolRun(nextSession.state, result.callId);
    if (record === undefined) continue;
    nextSession = removeWorkflowToolRun(
      clearProxyInputRequestsWhere(
        nextSession,
        (route) => route.answerHook?.runId === record.runId,
      ),
      record.callId,
    );
  }
  for (const result of readyResults) {
    if (result.kind !== "subagent-result") continue;
    const record = findWorkflowToolRun(nextSession.state, result.callId);
    if (record?.resultKind !== "subagent") continue;
    nextSession = removeWorkflowToolRun(
      clearProxyInputRequestsForChild(nextSession, record.hookToken),
      record.callId,
    );
  }

  const state = { ...nextSession.state };
  delete state[PENDING_COORDINATION_BATCH_KEY];
  nextSession = {
    ...nextSession,
    state: Object.keys(state).length > 0 ? state : undefined,
  };

  // Draw settled child spend down against the parent's session totals so
  // the session token limits and the remaining-quota budget granted to later
  // delegations account for what the tree has already spent. Every outcome
  // carries the child turn's `usageDelta`, folded exactly once per settled
  // result (each batch resolves once), so repeated turns of a persistent
  // child never double-count earlier turns. Only child-produced results
  // carry an outcome; parent-side dispatch failures never do.
  for (const result of readyResults) {
    if (result.kind !== "subagent-result") {
      continue;
    }
    const outcome = readSubagentResultOutcome(result);
    if (outcome === undefined) {
      continue;
    }
    nextSession = setTurnUsageState(
      nextSession,
      accumulateSessionUsage({
        previous: getTurnUsageState(nextSession.state),
        usage: outcome.usageDelta,
      }),
    );
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

function readBackgroundTaskReceipt(
  result: Extract<RuntimeActionResult, { kind: "subagent-result" }>,
): { readonly status: "working"; readonly taskId: string } | undefined {
  return "backgroundTask" in result ? result.backgroundTask : undefined;
}

/**
 * Projects one AI SDK tool call into the eve runtime-action contract.
 */
export function createRuntimeActionRequestFromToolCall(input: {
  readonly toolCall: TypedToolCall<ToolSet>;
  readonly tools: HarnessToolMap;
}): RuntimeActionRequest {
  const definition = input.tools.get(input.toolCall.toolName);

  if (definition?.frameworkAction === "load-skill") {
    return {
      callId: input.toolCall.toolCallId,
      input: resolveToolCallInputObject(input.toolCall.input, {
        callId: input.toolCall.toolCallId,
        toolName: input.toolCall.toolName,
      }),
      kind: "load-skill",
    };
  }

  return {
    callId: input.toolCall.toolCallId,
    input: resolveToolCallInputObject(input.toolCall.input, {
      callId: input.toolCall.toolCallId,
      toolName: input.toolCall.toolName,
    }),
    kind: "tool-call",
    toolName: input.toolCall.toolName,
  };
}

/** Projects one deferred harness tool call into task/control coordination. */
export function createCoordinationRequestFromToolCall(input: {
  readonly toolCall: TypedToolCall<ToolSet>;
  readonly tools: HarnessToolMap;
}):
  | { readonly kind: "runtime-action"; readonly request: RuntimeToolCallActionRequest }
  | { readonly kind: "task"; readonly request: RuntimeWorkflowTaskRequest } {
  const definition = input.tools.get(input.toolCall.toolName);
  const inputObject = resolveToolCallInputObject(input.toolCall.input, {
    callId: input.toolCall.toolCallId,
    toolName: input.toolCall.toolName,
  });
  if (definition?.runtimeAction?.kind === "task-control") {
    return {
      kind: "runtime-action",
      request: {
        callId: input.toolCall.toolCallId,
        input: inputObject,
        kind: "tool-call",
        toolName: input.toolCall.toolName,
      },
    };
  }
  if (definition?.task !== undefined) {
    return {
      kind: "task",
      request: {
        callId: input.toolCall.toolCallId,
        executeInput: definition.task.executeInput?.(inputObject),
        input: inputObject,
        kind: "workflow-task",
        resultKind: definition.task.resultKind,
        toolName: input.toolCall.toolName,
        workflowId: definition.task.workflowId,
      },
    };
  }
  throw new Error(`Deferred tool "${input.toolCall.toolName}" has no task or runtime action.`);
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
