import { ROOT_CONTEXT, context, type Context, type SpanContext, trace } from "@opentelemetry/api";

import type { AgentTraceStateStore } from "#tracing/eve/agent-trace-state.js";
import { createAgentActionInstrumentation } from "#tracing/eve/agent-action-instrumentation.js";
import { createAgentApprovalInstrumentation } from "#tracing/eve/agent-approval-instrumentation.js";
import { createAgentChannelDeliveryInstrumentation } from "#tracing/eve/agent-channel-delivery-instrumentation.js";
import { createAgentToolInstrumentation } from "#tracing/eve/agent-tool-instrumentation.js";
import { eveActivationMetadata } from "#tracing/eve/metadata.js";
import { createAgentMemoryInstrumentation } from "#tracing/eve/agent-memory-instrumentation.js";
import { readGatewayCostData } from "#tracing/eve/gateway.js";
import { createEveSessionTracing } from "#tracing/eve/session.js";
import type { TraceCapturePolicy } from "#tracing/eve/otel-declaration.js";
import { isSampledTrace } from "#shared/trace-policy.js";
import { createEveCapturePolicy } from "#tracing/eve/policy.js";
import { withChannelAudience } from "#tracing/eve/channel-audience-context.js";
import type {
  InstrumentationStepAttemptMetadataEvent,
  InstrumentationAttemptScope,
  InstrumentationStepAttemptStartedEvent,
  InstrumentationStepAttemptTerminalEvent,
  InstrumentationContextRunner,
  InstrumentationModelCallTerminalEvent,
  InstrumentationModelCallStartedEvent,
  InstrumentationProviderDefinition,
  InstrumentationSessionStartedEvent,
  InstrumentationTraceSeed,
  InstrumentationSessionTransitionEvent,
  InstrumentationTurnStartedEvent,
} from "#instrumentation/lifecycle.js";
import { resolveInstrumentationEnvironment } from "#internal/application/dev-environment.js";
import type { ConversationEnvironment } from "#shared/conversation-context.js";
import { eveOperationInput } from "#tracing/eve/operation-input.js";
import { gatewayCostAttributes } from "#tracing/eve/gateway.js";
import type {
  Operation as AttemptOperation,
  Operation as ModelOperation,
  DurableTraceRuntime,
} from "#tracing/lib/index.js";
import { isUserMessageKind } from "#harness/messages.js";
import { isObject } from "#shared/guards.js";

type SpanState<T = AttemptOperation> = { readonly runtime: T; readonly context: Context };

export interface AgentOtelInstrumentationInput {
  readonly tracing: DurableTraceRuntime;
  readonly environment?: ConversationEnvironment;
  /** Whether any destination records model and tool inputs. */
  readonly recordInputs?: boolean;
  /** Whether any destination records model and tool outputs. */
  readonly recordOutputs?: boolean;
  readonly frameworkVersion: string;
  readonly stateStore: AgentTraceStateStore;
  readonly tracePolicy?: TraceCapturePolicy;
}

/** OTel event definition and its trusted framework context runner. */
interface AgentOtelInstrumentation {
  readonly hook: InstrumentationProviderDefinition;
  readonly prepareSessionTrace: (
    event: InstrumentationSessionStartedEvent,
  ) => Promise<InstrumentationTraceSeed>;
  readonly prepareTurnTrace: (
    event: InstrumentationTurnStartedEvent,
  ) => Promise<InstrumentationTraceSeed>;
  readonly runInContext: InstrumentationContextRunner;
}

/** Creates OTel instrumentation for eve's structural and GenAI spans. */
export function createAgentOtelInstrumentation(
  input: AgentOtelInstrumentationInput,
): AgentOtelInstrumentation {
  const environment = input.environment ?? resolveInstrumentationEnvironment();
  const recordInputs = input.recordInputs ?? false;
  const recordOutputs = input.recordOutputs ?? false;
  const lifecycle = input.tracing;
  const attemptScopes = new Map<string, InstrumentationAttemptScope>();
  // A lost serverless worker retries the whole turn step from entry.
  const steps = new WeakMap<InstrumentationAttemptScope, SpanState>();
  const modelSpans = new WeakMap<
    InstrumentationAttemptScope,
    Map<string, SpanState<ModelOperation>>
  >();
  const actions = createAgentActionInstrumentation({
    lifecycle,
    frameworkVersion: input.frameworkVersion,
    recordInputs,
    recordOutputs,
    resolveTraceContext: async (event) => {
      const turn = await input.stateStore.get(
        "turn",
        JSON.stringify([event.scope.sessionId, event.scope.turnId]),
      );
      return turn?.context;
    },
    stateStore: input.stateStore,
  });
  const approvals = createAgentApprovalInstrumentation({
    lifecycle,
    actionContextFor: actions.contextFor,
    frameworkVersion: input.frameworkVersion,
  });
  const tools = createAgentToolInstrumentation({
    lifecycle,
    actionContextFor: actions.contextFor,
    recordInputs,
    recordOutputs,
    resolveFallback: (event) => {
      const scope = attemptScopes.get(event.scope.attemptId) ?? event.scope;
      const step = steps.get(scope);
      return step === undefined
        ? undefined
        : { context: step.context, spanContext: step.runtime.reference };
    },
  });
  const memory = createAgentMemoryInstrumentation({ ...input, environment, lifecycle });
  const sessionTracing = createEveSessionTracing({
    ...input,
    environment,
    lifecycle,
  });
  const { prepareSessionTrace, prepareTurnTrace } = sessionTracing;

  const capturePolicy = createEveCapturePolicy({
    stateStore: input.stateStore,
    environment,
    recordInputs,
    recordOutputs,
  });

  const onSessionStarted = async (event: InstrumentationSessionStartedEvent): Promise<void> => {
    await prepareSessionTrace(event);
  };

  const onTurnStarted = async (event: InstrumentationTurnStartedEvent): Promise<void> => {
    await prepareTurnTrace(event);
  };

  const onStepStarted = async (event: InstrumentationStepAttemptStartedEvent): Promise<void> => {
    const turn = await input.stateStore.get(
      "turn",
      JSON.stringify([event.scope.sessionId, event.scope.turnId]),
    );
    if (turn === undefined || !isSampledTrace(turn.context)) return;
    const session = await input.stateStore.get("session", event.scope.sessionId);
    const turnContext = withChannelAudience(
      contextFromSpanContext(turn.context),
      event.scope.channelAudience,
    );
    const activeSpanContext = trace.getSpan(context.active())?.spanContext();
    const runtime = await lifecycle.attempt({
      ...eveOperationInput(
        {
          ...event.scope,
          frameworkVersion: input.frameworkVersion,
          parent: turn.context,
          links:
            activeSpanContext === undefined || activeSpanContext.traceId === turn.context.traceId
              ? undefined
              : [{ relationship: "execution.delivery", context: activeSpanContext }],
        },
        event.idempotencyKey,
        turnContext,
      ),
      step: {
        index: event.scope.stepIndex,
        attempt: event.scope.attemptIndex,
        runtimeContext: event.runtimeContext,
        channel: eveActivationMetadata({ session, turn, sessionId: event.scope.sessionId }).channel,
      },
    });
    if (runtime === undefined) return;
    const stepContext = trace.setSpan(turnContext, trace.wrapSpanContext(runtime.reference));
    steps.set(event.scope, { runtime, context: stepContext });
    attemptScopes.set(event.scope.attemptId, event.scope);
  };

  const onStepTerminal = async (event: InstrumentationStepAttemptTerminalEvent): Promise<void> => {
    const scope = attemptScopes.get(event.scope.attemptId) ?? event.scope;
    await drainOpenSpans({ ...event, scope });
    await tools.drain(
      event.scope.attemptId,
      event.type === "step.attempt.failed" ? { error: event.error } : undefined,
    );
    if (event.type === "step.attempt.failed") {
      await actions.failForAttempt(scope, event.error);
    }
    attemptScopes.delete(event.scope.attemptId);
    const attempt = steps.get(scope);
    if (attempt === undefined) return;
    if (event.type === "step.attempt.failed") await attempt.runtime.fail(event.error);
    else await attempt.runtime.complete();
    steps.delete(scope);
  };

  const onSessionTransition = async (
    event: InstrumentationSessionTransitionEvent,
  ): Promise<void> => {
    await sessionTracing.sessionTransition(event);
    // `session.waiting` is not terminal — the session may resume with a new
    // turn that still needs its metadata — so only release session-scoped
    // state on terminal transitions.
    if (event.type === "session.completed" || event.type === "session.failed") {
      await actions.deleteForSession(event.sessionId);
      await input.stateStore.delete("session", event.sessionId);
    }
  };

  const onModelCallStarted = async (event: InstrumentationModelCallStartedEvent): Promise<void> => {
    const attempt = steps.get(event.scope);
    if (attempt === undefined) return;
    const runtime = await attempt.runtime.modelCall(
      {
        provider: event.model.provider,
        modelId: event.model.modelId,
        messages: recordInputs
          ? event.input?.messages.map((message) =>
              isObject(message) && message.role === "user"
                ? { ...message, kind: isUserMessageKind(message.kind) ? message.kind : undefined }
                : message,
            )
          : undefined,
        instructions: recordInputs ? event.input?.instructions : undefined,
        runtimeContext: event.runtimeContext,
      },
      event.idempotencyKey,
    );
    const state = {
      runtime,
      context: trace.setSpan(attempt.context, trace.wrapSpanContext(runtime.reference)),
    };
    getSpanStates(modelSpans, event.scope).set(event.idempotencyKey, state);
  };

  const onModelCallTerminal = async (
    event: InstrumentationModelCallTerminalEvent,
  ): Promise<void> => {
    const state = takeSpanState(modelSpans, event.scope, event.idempotencyKey);
    if (state === undefined) return;
    if (event.type === "model.call.failed") {
      await state.runtime.fail(event.error);
    } else {
      await sessionTracing.recordModelUsage(event.scope.sessionId, event.scope.turnId, event.usage);
      await state.runtime.complete({
        outcome: "completed",
        result: { ...event, content: recordOutputs ? event.content : undefined },
      });
    }
  };

  const channelDeliveries = createAgentChannelDeliveryInstrumentation({
    recordInputs,
    stateStore: input.stateStore,
  });

  const onStepMetadata = (event: InstrumentationStepAttemptMetadataEvent): void => {
    const attempt = steps.get(event.scope);
    if (attempt === undefined) return;
    // Vercel AI Gateway reports per-call cost in providerMetadata.gateway;
    // attributes exist only when it was actually the gateway serving the call.
    const cost = readGatewayCostData(event.providerMetadata);
    if (cost !== undefined) attempt.runtime.attributes(gatewayCostAttributes(cost));
  };

  return {
    hook: {
      events: {
        ...channelDeliveries,
        "action.completed": actions.events["action.completed"],
        "action.failed": actions.events["action.failed"],
        async "action.started"(event, ctx) {
          await actions.events["action.started"]!(event, ctx);
          await tools.actionStarted(event);
        },
        ...approvals,
        "step.attempt.completed": onStepTerminal,
        "step.attempt.failed": onStepTerminal,
        "step.attempt.metadata": onStepMetadata,
        "step.attempt.started": onStepStarted,
        "model.call.completed": onModelCallTerminal,
        "model.call.failed": onModelCallTerminal,
        "model.call.started": onModelCallStarted,
        "session.completed": onSessionTransition,
        "session.failed": onSessionTransition,
        "session.started": onSessionStarted,
        "session.waiting": onSessionTransition,
        ...tools.events,
        "turn.cancelled": sessionTracing.turnTerminal,
        "turn.completed": sessionTracing.turnTerminal,
        "turn.failed": sessionTracing.turnTerminal,
        "turn.started": onTurnStarted,
      },
      name: "eve.otel",
      projectEvent: capturePolicy.projectEvent,
      tracePolicy: () => ({ emit: true, recordInputs, recordOutputs }),
    },
    prepareSessionTrace,
    prepareTurnTrace,
    async runInContext(operation, execute) {
      if (operation.type === "memory.operation") return memory.runInContext(operation, execute);
      const scope = attemptScopes.get(operation.scope.attemptId) ?? operation.scope;
      const ceiling = { emit: true, ...(await capturePolicy.forOperation(operation.scope)) };
      const active =
        operation.type === "model.call"
          ? modelSpans.get(scope)?.get(operation.idempotencyKey)?.runtime
          : tools.operationFor(operation.scope.attemptId, operation.idempotencyKey);
      if (active !== undefined) return active.run(execute, ceiling);
      {
        const turn = await input.stateStore.get(
          "turn",
          JSON.stringify([operation.scope.sessionId, operation.scope.turnId]),
        );
        if (turn !== undefined) {
          const parent = withChannelAudience(
            contextFromSpanContext(turn.context),
            operation.scope.channelAudience,
          );
          return lifecycle.run(
            turn.context,
            { ...ceiling, emit: isSampledTrace(turn.context) },
            execute,
            parent,
          );
        }
      }
      return execute();
    },
  };

  async function drainOpenSpans(event: InstrumentationStepAttemptTerminalEvent): Promise<void> {
    for (const state of modelSpans.get(event.scope)?.values() ?? []) {
      if (event.type === "step.attempt.failed") await state.runtime.fail(event.error);
      else
        await state.runtime.complete({
          outcome: "completed",
          result: { finishReason: "unknown", usage: {} },
        });
    }
    modelSpans.delete(event.scope);
  }
}

function getSpanStates<T>(
  spans: WeakMap<InstrumentationAttemptScope, Map<string, T>>,
  scope: InstrumentationAttemptScope,
): Map<string, T> {
  let scoped = spans.get(scope);
  if (scoped === undefined) {
    scoped = new Map();
    spans.set(scope, scoped);
  }
  return scoped;
}

function takeSpanState<T>(
  spans: WeakMap<InstrumentationAttemptScope, Map<string, T>>,
  scope: InstrumentationAttemptScope,
  id: string,
): T | undefined {
  const scoped = spans.get(scope);
  const state = scoped?.get(id);
  if (scoped === undefined) return undefined;
  scoped.delete(id);
  if (scoped.size === 0) spans.delete(scope);
  return state;
}

function contextFromSpanContext(spanContext: SpanContext): Context {
  return trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(spanContext));
}
