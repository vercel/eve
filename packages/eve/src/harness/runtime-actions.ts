import type { ModelMessage, ToolSet, TypedToolCall } from "ai";

import { createActionResultEvent, type HandleMessageStreamEvent } from "#protocol/message.js";
import { getRuntimeActionRequestKey, getRuntimeActionResultKey } from "#runtime/actions/keys.js";
import type { RuntimeActionRequest, RuntimeActionResult } from "#runtime/actions/types.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import { clearProxyInputRequestsForChild } from "#harness/proxy-input-requests.js";
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
 * `childContinuationTokens` maps each `subagent-call` action's
 * `callId` to the deterministic child token minted by dispatch, so
 * the harness can clear proxy-input entries on result resolution
 * without re-deriving the token (keeps `harness/` runtime-agnostic).
 */
interface PendingRuntimeActionBatch {
  readonly actions: readonly RuntimeActionRequest[];
  readonly childContinuationTokens?: Readonly<Record<string, string>>;
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
  const state = { ...session.state };
  delete state[PENDING_RUNTIME_ACTION_BATCH_KEY];
  return { ...session, state: Object.keys(state).length > 0 ? state : undefined };
}

/**
 * Stores one pending runtime-action batch on the session.
 */
export function setPendingRuntimeActionBatch(input: {
  readonly actions: readonly RuntimeActionRequest[];
  readonly event: PendingRuntimeActionEventMetadata;
  readonly responseMessages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): HarnessSession {
  const state = { ...input.session.state };
  state[PENDING_RUNTIME_ACTION_BATCH_KEY] = {
    actions: [...input.actions],
    event: input.event,
    responseMessages: [...input.responseMessages],
  } satisfies PendingRuntimeActionBatch;

  return { ...input.session, state };
}

/**
 * Records the child continuation token for a dispatched subagent-call
 * so {@link resolvePendingRuntimeActions} can clear proxy-input
 * entries when the child finishes.
 */
export function recordPendingSubagentChildToken(input: {
  readonly callId: string;
  readonly childContinuationToken: string;
  readonly session: HarnessSession;
}): HarnessSession {
  const batch = getPendingRuntimeActionBatch(input.session.state);

  if (batch === undefined) {
    return input.session;
  }

  const state = { ...input.session.state };
  state[PENDING_RUNTIME_ACTION_BATCH_KEY] = {
    ...batch,
    childContinuationTokens: {
      ...batch.childContinuationTokens,
      [input.callId]: input.childContinuationToken,
    },
  } satisfies PendingRuntimeActionBatch;

  return { ...input.session, state };
}

/**
 * Discriminated item consumed by {@link accumulateRuntimeActionResults}
 * so the loop can process interleaved deliveries and results without
 * coupling to a concrete `HookPayload` shape.
 */
type RuntimeActionAccumulatorItem<TDeliver> =
  | { readonly kind: "deliver"; readonly value: TDeliver }
  | { readonly kind: "runtime-action-result"; readonly results: readonly RuntimeActionResult[] };

/**
 * Accumulates runtime-action results until every pending key has a
 * matching result. The caller passes the ordered key list so the
 * workflow runtime can drive the loop without hydrating a session.
 */
export async function accumulateRuntimeActionResults<TDeliver>(input: {
  readonly bufferedDeliveries: TDeliver[];
  readonly getNext: () => Promise<RuntimeActionAccumulatorItem<TDeliver> | null>;
  readonly initialResults?: readonly RuntimeActionResult[];
  readonly pendingActionKeys: readonly string[] | undefined;
}): Promise<RuntimeActionResult[] | null> {
  const pendingKeys = input.pendingActionKeys;
  const buffered: RuntimeActionResult[] = [...(input.initialResults ?? [])];

  if (pendingKeys !== undefined && buffered.length > 0) {
    const ready = resolveRuntimeActionResultsForKeys({
      pendingKeys,
      results: buffered,
    });

    if (ready !== undefined) {
      return ready;
    }
  }

  while (true) {
    const item = await input.getNext();

    if (item === null) {
      return null;
    }

    if (item.kind === "deliver") {
      input.bufferedDeliveries.push(item.value);
      continue;
    }

    buffered.push(...item.results);

    if (pendingKeys === undefined) {
      // No pending batch; nothing to resolve. Keep draining so the
      // stream state stays consistent.
      continue;
    }

    const ready = resolveRuntimeActionResultsForKeys({
      pendingKeys,
      results: buffered,
    });

    if (ready !== undefined) {
      return ready;
    }
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

  return resolveRuntimeActionResultsForBatch({ batch, results: input.results });
}

function resolveRuntimeActionResultsForBatch(input: {
  readonly batch: PendingRuntimeActionBatch;
  readonly results: readonly RuntimeActionResult[];
}): RuntimeActionResult[] | undefined {
  return resolveRuntimeActionResultsForKeys({
    pendingKeys: input.batch.actions.map((action) => getRuntimeActionRequestKey(action)),
    results: input.results,
  });
}

function resolveRuntimeActionResultsForKeys(input: {
  readonly pendingKeys: readonly string[];
  readonly results: readonly RuntimeActionResult[];
}): RuntimeActionResult[] | undefined {
  const pendingKeySet = new Set(input.pendingKeys);
  const resultsByKey = new Map<string, RuntimeActionResult>();

  for (const result of input.results) {
    const key = getRuntimeActionResultKey(result);

    if (!pendingKeySet.has(key)) {
      continue;
    }

    resultsByKey.set(key, result);
  }

  const orderedResults: RuntimeActionResult[] = [];

  for (const key of input.pendingKeys) {
    const result = resultsByKey.get(key);

    if (result === undefined) {
      return undefined;
    }

    orderedResults.push(result);
  }

  return orderedResults;
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
        await input.emit({
          data: {
            callId: result.callId,
            output:
              typeof result.output === "string" ? result.output : JSON.stringify(result.output),
            subagentName: result.subagentName,
          },
          type: "subagent.completed",
        } satisfies Extract<HandleMessageStreamEvent, { type: "subagent.completed" }>);
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

  const state = { ...input.session.state };
  delete state[PENDING_RUNTIME_ACTION_BATCH_KEY];

  let nextSession: HarnessSession = {
    ...input.session,
    state: Object.keys(state).length > 0 ? state : undefined,
  };

  // Clear proxy-input entries for completed children so future
  // deliveries don't route responses to a dead child.
  const childTokens = batch.childContinuationTokens;
  if (childTokens !== undefined) {
    for (const result of readyResults) {
      if (result.kind !== "subagent-result") {
        continue;
      }

      const childToken = childTokens[result.callId];
      if (childToken !== undefined) {
        nextSession = clearProxyInputRequestsForChild(nextSession, childToken);
      }
    }
  }

  const toolResults = readyResults.map((result) => {
    switch (result.kind) {
      case "load-skill-result":
        return {
          output: toToolResultOutput(result),
          toolCallId: result.callId,
          toolName: "load_skill",
          type: "tool-result" as const,
        };
      case "subagent-result":
        return {
          output: toToolResultOutput(result),
          toolCallId: result.callId,
          toolName: result.subagentName,
          type: "tool-result" as const,
        };
      case "tool-result":
        return {
          output: toToolResultOutput(result),
          toolCallId: result.callId,
          toolName: result.toolName,
          type: "tool-result" as const,
        };
    }

    throw new Error(`Unsupported runtime action result kind "${String(result)}".`);
  });

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

  if (definition?.runtimeAction?.kind === "subagent-call") {
    return {
      callId: input.toolCall.toolCallId,
      description: definition.description,
      input: resolveToolCallInputObject(input.toolCall.input, {
        callId: input.toolCall.toolCallId,
        toolName: input.toolCall.toolName,
      }),
      kind: "subagent-call",
      name: definition.name,
      nodeId: definition.runtimeAction.nodeId,
      subagentName: definition.runtimeAction.subagentName,
    };
  }

  if (definition?.runtimeAction?.kind === "remote-agent-call") {
    return {
      callId: input.toolCall.toolCallId,
      description: definition.description,
      input: resolveToolCallInputObject(input.toolCall.input, {
        callId: input.toolCall.toolCallId,
        toolName: input.toolCall.toolName,
      }),
      kind: "remote-agent-call",
      name: definition.name,
      nodeId: definition.runtimeAction.nodeId,
      remoteAgentName: definition.runtimeAction.remoteAgentName ?? definition.name,
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

/**
 * Coerces an AI SDK tool-call `input` into the runtime-action `JsonObject`
 * contract, throwing a `TypeError` (with the original as `cause`) that names
 * the offending tool when the payload is not a JSON object.
 */
export function resolveToolCallInputObject(
  value: unknown,
  context: { readonly callId: string; readonly toolName: string },
): JsonObject {
  if (value === undefined || value === null) {
    return {};
  }

  try {
    return parseJsonObject(value);
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
