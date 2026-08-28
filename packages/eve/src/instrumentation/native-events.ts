import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { contextStorage } from "#context/container.js";
import { instrumentChannelDelivery } from "#instrumentation/channel-delivery.js";
import type {
  InstrumentationActionFailedEvent,
  InstrumentationActionStartedEvent,
  InstrumentationAttemptScope,
  InstrumentationHooks,
  InstrumentationInputRequestedEvent,
  InstrumentationInputResolvedEvent,
  InstrumentationParentLineage,
  InstrumentationPointEvent,
  InstrumentationTraceContext,
  InstrumentationUsage,
} from "#instrumentation/lifecycle.js";
import {
  actionIdempotencyKey,
  inputIdempotencyKey,
  sessionIdempotencyKey,
  turnIdempotencyKey,
} from "#instrumentation/lifecycle.js";
import {
  rememberInstrumentationActionScope,
  rememberInstrumentationInputScope,
  takeInstrumentationActionScopeForCall,
  takeInstrumentationInputScope,
} from "#instrumentation/state.js";
import type { ResolvedInputBatch } from "#harness/input-requests.js";
import { RuntimeActionSettlementTimesKey } from "#harness/runtime-action-settlement-state.js";
import type { HandleEventFn } from "#harness/types.js";
import type { RuntimeActionRequest, RuntimeActionResult } from "#shared/action-types.js";
import type { ChannelAudience } from "#shared/channel-audience.js";

export interface CreateInstrumentationHandleEventInput {
  readonly agentName?: string;
  readonly channelKind?: string;
  readonly channelAudience?: ChannelAudience;
  readonly getAttemptScope?: () => InstrumentationAttemptScope | undefined;
  readonly handleEvent?: HandleEventFn;
  readonly hooks?: InstrumentationHooks;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly parentTraceContext?: InstrumentationTraceContext;
  readonly rootSessionId?: string;
  readonly sessionId: string;
  readonly turnId?: string;
}

/** Publishes eve-native lifecycle transitions after durable event acceptance. */
export function createInstrumentationHandleEvent(
  input: CreateInstrumentationHandleEventInput,
): HandleEventFn | undefined {
  if (input.hooks === undefined) return input.handleEvent;
  if (input.handleEvent === undefined) return undefined;

  const handleEvent = input.handleEvent;
  const hooks = input.hooks;
  const publishedActions = new Set<string>();
  const publishedInputs = new Set<string>();
  let activeTurnId = input.turnId;
  return async (event, messages) => {
    await handleEvent(event, messages);
    const lifecycleEvent = toLifecycleEvent(event, input, activeTurnId);
    if (event.type === "turn.started") activeTurnId = event.data.turnId;
    if (
      event.type === "turn.cancelled" ||
      event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "session.completed" ||
      event.type === "session.failed"
    ) {
      const ctx = contextStorage.getStore();
      if (ctx !== undefined) {
        await instrumentChannelDelivery({
          ctx,
          error:
            event.type === "turn.failed" || event.type === "session.failed"
              ? new Error(event.data.message)
              : undefined,
          errorCode:
            event.type === "turn.failed" || event.type === "session.failed"
              ? event.data.code
              : undefined,
          hooks,
          includeTurn:
            event.type === "turn.cancelled" ||
            event.type === "turn.completed" ||
            event.type === "turn.failed",
          outcome:
            event.type === "turn.failed" || event.type === "session.failed"
              ? "failed"
              : event.type === "turn.cancelled"
                ? "cancelled"
                : "completed",
        });
      }
    }
    if (lifecycleEvent !== undefined) await hooks.publish(lifecycleEvent);
    if (event.type === "actions.requested") {
      await publishActionStarts(event, input, hooks, publishedActions);
    } else if (event.type === "action.result") {
      await publishActionTerminal(event, input, hooks);
    } else if (event.type === "input.requested") {
      await publishInputStarts(event, input, hooks, publishedInputs);
    }
  };
}

async function publishInputStarts(
  event: Extract<UnstampedMessageStreamEvent, { type: "input.requested" }>,
  input: CreateInstrumentationHandleEventInput,
  hooks: InstrumentationHooks,
  published: Set<string>,
): Promise<void> {
  const scope = input.getAttemptScope?.();
  if (scope === undefined) return;

  for (const request of event.data.requests) {
    const idempotencyKey = inputIdempotencyKey(
      input.sessionId,
      event.data.turnId,
      request.requestId,
    );
    if (published.has(idempotencyKey)) continue;
    published.add(idempotencyKey);
    rememberInstrumentationInputScope(idempotencyKey, scope);
    await hooks.publish(
      Object.freeze({
        action: Object.freeze({
          callId: request.action.callId,
          name: request.action.toolName,
        }),
        idempotencyKey,
        kind: request.kind,
        request: hooks.capturesContent
          ? Object.freeze({
              allowFreeform: request.allowFreeform,
              display: request.display,
              options: request.options,
              prompt: request.prompt,
            })
          : undefined,
        requestId: request.requestId,
        scope,
        type: "input.requested",
      } satisfies InstrumentationInputRequestedEvent),
    );
  }
}

/** Publishes accepted input resolutions against their original request scope. */
export async function publishInputResolutions(input: {
  readonly batch: ResolvedInputBatch;
  readonly hooks: InstrumentationHooks;
  readonly sessionId: string;
}): Promise<void> {
  for (const resolved of input.batch.inputs) {
    const idempotencyKey = inputIdempotencyKey(
      input.sessionId,
      input.batch.event.turnId,
      resolved.request.requestId,
    );
    const scope = takeInstrumentationInputScope(idempotencyKey);
    if (scope === undefined) continue;
    await input.hooks.publish(
      Object.freeze({
        idempotencyKey,
        kind: resolved.request.kind,
        outcome: resolved.outcome,
        requestId: resolved.request.requestId,
        response:
          !input.hooks.capturesContent || resolved.response === undefined
            ? undefined
            : Object.freeze({
                optionId: resolved.response.optionId,
                text: resolved.response.text,
              }),
        scope,
        type: "input.resolved",
      } satisfies InstrumentationInputResolvedEvent),
    );
  }
}

async function publishActionStarts(
  event: Extract<UnstampedMessageStreamEvent, { type: "actions.requested" }>,
  input: CreateInstrumentationHandleEventInput,
  hooks: InstrumentationHooks,
  published: Set<string>,
): Promise<void> {
  const scope = input.getAttemptScope?.();
  if (scope === undefined) return;

  for (const action of event.data.actions) {
    const idempotencyKey = actionIdempotencyKey(input.sessionId, event.data.turnId, action.callId);
    if (published.has(idempotencyKey)) continue;
    published.add(idempotencyKey);
    rememberInstrumentationActionScope(idempotencyKey, scope);
    await hooks.publish(
      Object.freeze({
        callId: action.callId,
        idempotencyKey,
        input: hooks.capturesContent ? action.input : undefined,
        kind: action.kind,
        name: actionName(action),
        scope,
        type: "action.started",
      } satisfies InstrumentationActionStartedEvent),
    );
  }
}

async function publishActionTerminal(
  event: Extract<UnstampedMessageStreamEvent, { type: "action.result" }>,
  input: CreateInstrumentationHandleEventInput,
  hooks: InstrumentationHooks,
): Promise<void> {
  const correlation = takeInstrumentationActionScopeForCall(
    input.sessionId,
    event.data.result.callId,
  );
  if (correlation === undefined) return;
  const { idempotencyKey, scope } = correlation;

  if (event.data.status === "completed") {
    await hooks.publish(
      Object.freeze({
        acceptedAtMs: contextStorage.getStore()?.get(RuntimeActionSettlementTimesKey)?.[
          event.data.result.callId
        ],
        idempotencyKey,
        outcome: "completed",
        output: Object.freeze(
          hooks.capturesContent
            ? { output: event.data.result.output, type: "result" }
            : { type: "result" },
        ),
        scope,
        type: "action.completed",
        usage: actionUsage(event.data.result),
      }),
    );
    return;
  }

  const error =
    event.data.error === undefined
      ? event.data.result.output
      : Object.assign(new Error(event.data.error.message), { code: event.data.error.code });
  await hooks.publish(
    Object.freeze({
      acceptedAtMs: contextStorage.getStore()?.get(RuntimeActionSettlementTimesKey)?.[
        event.data.result.callId
      ],
      error,
      errorCode: event.data.error?.code,
      idempotencyKey,
      outcome: event.data.status,
      scope,
      type: "action.failed",
    } satisfies InstrumentationActionFailedEvent),
  );
}

function actionUsage(result: RuntimeActionResult): InstrumentationUsage | undefined {
  if (
    result.kind !== "subagent-result" ||
    result.origin !== "child" ||
    result.usage === undefined
  ) {
    return undefined;
  }
  return {
    inputTokenDetails: {
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
    },
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };
}

function actionName(action: RuntimeActionRequest): string {
  if (action.kind === "tool-call") return action.toolName;
  if (action.kind === "load-skill") return "load_skill";
  return action.name;
}

function toLifecycleEvent(
  event: UnstampedMessageStreamEvent,
  input: CreateInstrumentationHandleEventInput,
  activeTurnId: string | undefined,
): InstrumentationPointEvent | undefined {
  switch (event.type) {
    case "session.started":
      return {
        agentName: input.agentName,
        channelAudience: input.channelAudience,
        channelKind: input.channelKind,
        idempotencyKey: sessionIdempotencyKey(input.sessionId),
        parentTraceContext: input.parentTraceContext,
        rootSessionId: input.rootSessionId ?? input.sessionId,
        sessionId: input.sessionId,
        type: "session.started",
      };
    case "session.completed":
    case "session.waiting":
      return {
        idempotencyKey: sessionIdempotencyKey(input.sessionId),
        sessionId: input.sessionId,
        turnId: activeTurnId,
        type: event.type,
      };
    case "session.failed":
      return {
        error: new Error(event.data.message),
        idempotencyKey: sessionIdempotencyKey(input.sessionId),
        sessionId: input.sessionId,
        turnId: activeTurnId,
        type: "session.failed",
      };
    case "turn.started":
      return {
        idempotencyKey: turnIdempotencyKey(input.sessionId, event.data.turnId),
        parentLineage: input.parentLineage,
        parentTraceContext: input.parentTraceContext,
        rootSessionId: input.rootSessionId ?? input.sessionId,
        sequence: event.data.sequence,
        sessionId: input.sessionId,
        turnId: event.data.turnId,
        type: "turn.started",
      };
    case "turn.completed":
    case "turn.cancelled":
      return {
        idempotencyKey: turnIdempotencyKey(input.sessionId, event.data.turnId),
        sessionId: input.sessionId,
        turnId: event.data.turnId,
        type: event.type,
      };
    case "turn.failed":
      return {
        error: new Error(event.data.message),
        idempotencyKey: turnIdempotencyKey(input.sessionId, event.data.turnId),
        sessionId: input.sessionId,
        turnId: event.data.turnId,
        type: "turn.failed",
      };
    default:
      return undefined;
  }
}
