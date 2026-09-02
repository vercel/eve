import type { ModelMessage, ToolSet, TypedToolCall } from "ai";

import { createActionResultEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";
import { getPendingDispatchActionKey } from "#runtime/actions/keys.js";
import { resolveRuntimeActionResultsForKeys } from "#runtime/actions/results.js";
import type { RuntimeActionRequest, RuntimeActionResult } from "#shared/action-types.js";
import type { PendingDispatchAction } from "#shared/dispatch-action.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import type { AgentTurnOutcome } from "#shared/agent-turn-outcome.js";
import { findRunningAgentHandle, isResultBoundToRunningHandle } from "#harness/handles/query.js";
import { settleAgentTurn } from "#harness/handles/transitions.js";
import {
  clearProxyInputRequestsForChild,
  clearProxyInputRequestsWhere,
} from "#harness/proxy-input-requests.js";
import {
  getPendingInputBatches,
  removePendingInputBatches,
} from "#harness/pending-input-batches.js";
import { renderPendingApprovalsSnippet } from "#harness/hitl/approval-prompt.js";
import { findToolRun, removeToolRun } from "#harness/tool-runs.js";
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

const PENDING_RUNTIME_ACTION_BATCH_KEY = "eve.runtime.pendingActionBatch";
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
 * Serializable event coordinates for one pending runtime-action batch.
 *
 * Runtime action results are projected back onto the parent stream using the
 * same turn and step identity as the originating `actions.requested` batch.
 */
interface PendingRuntimeActionEventMetadata {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/**
 * Serializable pending runtime-action batch stored on `session.state`.
 *
 * Child ownership does not live here: the agent handle store records every
 * dispatched child (from before its start side effect) and is the sole
 * authority for continuing, settling, and cancelling children.
 */
export interface PendingRuntimeActionBatch {
  readonly actions: readonly PendingDispatchAction[];
  readonly event: PendingRuntimeActionEventMetadata;
  readonly responseMessages: readonly ModelMessage[];
}

/**
 * Outcome of resolving a pending runtime-action batch.
 */
interface ResolvePendingRuntimeActionsResult {
  readonly messages: ModelMessage[];
  readonly outcome: "continue" | "resolved" | "unresolved";
  readonly session: HarnessSession;
}

/** Returns the pending runtime-action batch stored on the session, if any. */
export function getPendingRuntimeActionBatch(
  state: SessionStateMap | undefined,
): PendingRuntimeActionBatch | undefined {
  const value = state?.[PENDING_RUNTIME_ACTION_BATCH_KEY];

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const batch = value as PendingRuntimeActionBatch;

  if (
    !Array.isArray(batch.actions) ||
    !Array.isArray(batch.responseMessages) ||
    typeof batch.event !== "object" ||
    batch.event === null
  ) {
    return undefined;
  }

  return batch;
}

/**
 * Returns true when the session is parked on a pending runtime-action batch.
 */
export function hasPendingRuntimeActionBatch(state: SessionStateMap | undefined): boolean {
  return getPendingRuntimeActionBatch(state) !== undefined;
}

export function clearPendingRuntimeActionBatch(session: HarnessSession): HarnessSession {
  if (session.state?.[PENDING_RUNTIME_ACTION_BATCH_KEY] === undefined) {
    return session;
  }

  const runtimeBatch = getPendingRuntimeActionBatch(session.state);
  const coOwnedInputBatches = getPendingInputBatches(session.state).filter(
    (inputBatch) =>
      runtimeBatch !== undefined &&
      inputBatch.event?.sequence === runtimeBatch.event.sequence &&
      inputBatch.event.stepIndex === runtimeBatch.event.stepIndex &&
      inputBatch.event.turnId === runtimeBatch.event.turnId,
  );
  const pendingApprovalSnippets = new Set(
    coOwnedInputBatches
      .map((batch) => renderPendingApprovalsSnippet(batch.requests))
      .filter((snippet): snippet is string => snippet !== undefined),
  );
  const history = [...session.history];
  const lastMessage = history.at(-1);
  if (
    lastMessage?.role === "user" &&
    typeof lastMessage.content === "string" &&
    pendingApprovalSnippets.has(lastMessage.content)
  ) {
    history.pop();
  }
  const clearedSession = removePendingInputBatches({ ...session, history }, coOwnedInputBatches);
  const state = { ...clearedSession.state };
  delete state[PENDING_RUNTIME_ACTION_BATCH_KEY];
  return { ...clearedSession, state: Object.keys(state).length > 0 ? state : undefined };
}

/**
 * Stores one pending runtime-action batch on the session.
 */
export function setPendingRuntimeActionBatch(input: {
  readonly actions: readonly PendingDispatchAction[];
  readonly event: PendingRuntimeActionEventMetadata;
  readonly responseMessages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): HarnessSession {
  assertUniqueRuntimeActionCallIds(input.actions);
  const state = { ...input.session.state };
  state[PENDING_RUNTIME_ACTION_BATCH_KEY] = {
    actions: [...input.actions],
    event: input.event,
    responseMessages: [...input.responseMessages],
  } satisfies PendingRuntimeActionBatch;

  return { ...input.session, state };
}

/** Rejects an ambiguous action batch before any result or side effect can bind by call id. */
export function assertUniqueRuntimeActionCallIds(actions: readonly PendingDispatchAction[]): void {
  const seen = new Set<string>();
  for (const action of actions) {
    if (seen.has(action.callId)) {
      throw new Error(`Runtime action batch contains duplicate callId "${action.callId}".`);
    }
    seen.add(action.callId);
  }
}

/**
 * Returns the stable ordered runtime-action results for the current pending
 * batch when every action has a matching result. Unknown and duplicate results
 * are ignored.
 */
function resolveReadyRuntimeActionResults(input: {
  readonly results: readonly RuntimeActionResult[];
  readonly session: HarnessSession;
}): RuntimeActionResult[] | undefined {
  const batch = getPendingRuntimeActionBatch(input.session.state);

  if (batch === undefined) {
    return undefined;
  }

  return resolveRuntimeActionResultsForBatch({
    batch,
    results: input.results,
    state: input.session.state,
  });
}

function resolveRuntimeActionResultsForBatch(input: {
  readonly batch: PendingRuntimeActionBatch;
  readonly results: readonly RuntimeActionResult[];
  readonly state: SessionStateMap | undefined;
}): RuntimeActionResult[] | undefined {
  return resolveRuntimeActionResultsForKeys({
    pendingKeys: input.batch.actions.map((action) => getPendingDispatchActionKey(action)),
    results: input.results.filter((result) => isResultBoundToRunningHandle(input.state, result)),
  });
}

/**
 * Resolves one pending runtime-action batch back into model history.
 *
 * When all expected runtime action results are present, this appends the
 * stored assistant tool-call messages plus synthesized tool-result messages to
 * history, clears the pending batch, and emits `subagent.completed` and
 * `action.result` events back onto the parent stream.
 */
export async function resolvePendingRuntimeActions(input: {
  readonly emit?: HarnessEmitFn;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
  /** Definitions whose `toModelOutput` projects a workflow tool's result for the model. */
  readonly tools?: HarnessToolMap;
}): Promise<ResolvePendingRuntimeActionsResult> {
  const batch = getPendingRuntimeActionBatch(input.session.state);

  if (batch === undefined) {
    return {
      messages: [...input.session.history],
      outcome: "continue",
      session: input.session,
    };
  }

  const readyResults = resolveReadyRuntimeActionResults({
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
    const record = findToolRun(nextSession.state, result.callId);
    if (record === undefined) continue;
    nextSession = removeToolRun(
      clearProxyInputRequestsWhere(
        nextSession,
        (route) => route.answerHook?.runId === record.runId,
      ),
      record.callId,
    );
  }

  const state = { ...nextSession.state };
  delete state[PENDING_RUNTIME_ACTION_BATCH_KEY];
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
  const toolInput = resolveToolCallInputObject(input.toolCall.input, {
    callId: input.toolCall.toolCallId,
    toolName: input.toolCall.toolName,
  });

  if (definition?.behavior?.presentation === "load-skill") {
    return {
      callId: input.toolCall.toolCallId,
      input: toolInput,
      kind: "load-skill",
    };
  }

  const target =
    definition?.execution === "background" || definition?.behavior?.handling?.kind !== "dispatch"
      ? undefined
      : definition.behavior.handling.target;
  if (
    definition !== undefined &&
    (target?.kind === "self-agent-call" || target?.kind === "subagent-call")
  ) {
    return {
      callId: input.toolCall.toolCallId,
      description: definition.description,
      input: toolInput,
      kind: "subagent-call",
      name: definition.name,
      nodeId: target.nodeId,
      subagentName: target.subagentName,
    };
  }

  if (definition !== undefined && target?.kind === "remote-agent-call") {
    return {
      callId: input.toolCall.toolCallId,
      description: definition.description,
      input: toolInput,
      kind: "remote-agent-call",
      name: definition.name,
      nodeId: target.nodeId,
      remoteAgentName: target.remoteAgentName,
    };
  }

  return {
    callId: input.toolCall.toolCallId,
    input: toolInput,
    kind: "tool-call",
    toolName: input.toolCall.toolName,
  };
}

/** Projects one execute-less dispatch tool call into the durable pending contract. */
export function createPendingDispatchActionFromToolCall(input: {
  readonly toolCall: TypedToolCall<ToolSet>;
  readonly tools: HarnessToolMap;
}): PendingDispatchAction {
  const definition = input.tools.get(input.toolCall.toolName);
  if (definition === undefined) {
    throw new Error(`Unknown tool "${input.toolCall.toolName}" in dispatch projection.`);
  }
  const handling = definition.behavior?.handling;
  if (handling?.kind !== "dispatch" || definition.execution === "background") {
    throw new Error(`Tool "${input.toolCall.toolName}" is not a durable dispatch tool.`);
  }
  return {
    callId: input.toolCall.toolCallId,
    description: definition.description,
    input: resolveToolCallInputObject(input.toolCall.input, {
      callId: input.toolCall.toolCallId,
      toolName: input.toolCall.toolName,
    }),
    target: handling.target,
    toolName: definition.name,
  };
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
