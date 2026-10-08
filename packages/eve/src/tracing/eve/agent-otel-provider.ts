import { ROOT_CONTEXT, context, trace } from "@opentelemetry/api";

import type { AgentTraceStateStore } from "#tracing/eve/agent-trace-state.js";
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
import { createEveTracing } from "#tracing/eve/operation-input.js";
import { gatewayCostAttributes } from "#tracing/eve/gateway.js";
import type {
  AgentSpanIdGenerator,
  AgentTelemetry,
  AttemptOperation,
  ModelOperation,
} from "#tracing/lib/index.js";
import { isUserMessageKind } from "#harness/messages.js";
import { isObject } from "#shared/guards.js";

export interface AgentOtelInstrumentationInput {
  /** Span output for eve's agent spans; its `ids` make turns durable across workers. */
  readonly telemetry: AgentTelemetry;
  readonly idGenerator: AgentSpanIdGenerator;
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
  const tracing = createEveTracing(input);
  // Attempts run in one process; a lost serverless worker retries the whole step.
  const steps = new Map<string, AttemptOperation>();
  const modelSpans = new Map<string, Map<string, ModelOperation>>();
  const sessionTracing = createEveSessionTracing({ ...input, environment, tracing });
  const { prepareSessionTrace, prepareTurnTrace } = sessionTracing;

  /** The attempt in its turn's tree, hydrating it when another process started it. */
  async function attemptFor(scope: InstrumentationAttemptScope) {
    const known = steps.get(scope.attemptId);
    if (known !== undefined) return known;
    const turn = await sessionTracing.turnFor(
      scope.sessionId,
      scope.turnId,
      withChannelAudience(ROOT_CONTEXT, scope.channelAudience),
    );
    const index = { stepIndex: scope.stepIndex, attempt: scope.attemptIndex };
    return turn?.findAttempt(index) ?? (turn?.finished === false ? turn.attempt(index) : undefined);
  }

  const tools = createAgentToolInstrumentation({
    tracing,
    attemptFor,
    stepFor: (scope) => steps.get(scope.attemptId),
    recordInputs,
    recordOutputs,
    stateStore: input.stateStore,
  });
  const approvals = createAgentApprovalInstrumentation({
    tracing,
    actionStateFor: tools.stateFor,
  });
  const memory = createAgentMemoryInstrumentation({ ...input, environment, tracing });

  const capturePolicy = createEveCapturePolicy({
    stateStore: input.stateStore,
    environment,
    recordInputs,
    recordOutputs,
  });

  function turnState(scope: { sessionId: string; turnId: string }) {
    return input.stateStore.get("turn", JSON.stringify([scope.sessionId, scope.turnId]));
  }

  const onSessionStarted = async (event: InstrumentationSessionStartedEvent): Promise<void> => {
    await prepareSessionTrace(event);
  };

  const onTurnStarted = async (event: InstrumentationTurnStartedEvent): Promise<void> => {
    await prepareTurnTrace(event);
  };

  const onStepStarted = async (event: InstrumentationStepAttemptStartedEvent): Promise<void> => {
    const turn = await turnState(event.scope);
    if (turn === undefined || !isSampledTrace(turn.context)) return;
    const session = await input.stateStore.get("session", event.scope.sessionId);
    const operation = await sessionTracing.turnFor(
      event.scope.sessionId,
      event.scope.turnId,
      withChannelAudience(ROOT_CONTEXT, event.scope.channelAudience),
    );
    if (operation === undefined || operation.finished) return;
    const activeSpanContext = trace.getSpan(context.active())?.spanContext();
    const attempt = await operation.attempt({
      stepIndex: event.scope.stepIndex,
      attempt: event.scope.attemptIndex,
      runtimeContext: event.runtimeContext,
      channel: eveActivationMetadata({ session, turn, sessionId: event.scope.sessionId }).channel,
      links:
        activeSpanContext === undefined || activeSpanContext.traceId === turn.context.traceId
          ? undefined
          : [{ relationship: "execution.delivery", context: activeSpanContext }],
    });
    steps.set(event.scope.attemptId, attempt);
  };

  const onStepTerminal = async (event: InstrumentationStepAttemptTerminalEvent): Promise<void> => {
    const failure = event.type === "step.attempt.failed" ? { error: event.error } : undefined;
    await drainOpenSpans(event);
    await tools.drain(event.scope.attemptId, failure);
    const attempt = steps.get(event.scope.attemptId) ?? (await attemptFor(event.scope));
    steps.delete(event.scope.attemptId);
    if (failure !== undefined) {
      // A failed attempt also fails the tool calls it dispatched.
      await attempt?.fail(failure.error);
      await tools.forgetAttempt(event.scope);
    } else await attempt?.complete();
  };

  const onSessionTransition = async (
    event: InstrumentationSessionTransitionEvent,
  ): Promise<void> => {
    await sessionTracing.sessionTransition(event);
    // `session.waiting` is not terminal — the session may resume with a new
    // turn that still needs its metadata — so only release session-scoped
    // state on terminal transitions.
    if (event.type === "session.completed" || event.type === "session.failed") {
      await tools.deleteForSession(event.sessionId);
      await input.stateStore.delete("session", event.sessionId);
    }
  };

  const onModelCallStarted = async (event: InstrumentationModelCallStartedEvent): Promise<void> => {
    const attempt = steps.get(event.scope.attemptId);
    if (attempt === undefined) return;
    const operation = await attempt.modelCall(
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
        tools: recordInputs ? event.input?.tools : undefined,
        runtimeContext: event.runtimeContext,
      },
      event.idempotencyKey,
    );
    let models = modelSpans.get(event.scope.attemptId);
    if (models === undefined) modelSpans.set(event.scope.attemptId, (models = new Map()));
    models.set(event.idempotencyKey, operation);
  };

  const onModelCallTerminal = async (
    event: InstrumentationModelCallTerminalEvent,
  ): Promise<void> => {
    const models = modelSpans.get(event.scope.attemptId);
    const operation = models?.get(event.idempotencyKey);
    models?.delete(event.idempotencyKey);
    if (operation === undefined) return;
    if (event.type === "model.call.failed") await operation.fail(event.error);
    else
      await operation.complete({
        outcome: "completed",
        result: { ...event, content: recordOutputs ? event.content : undefined },
      });
  };

  const channelDeliveries = createAgentChannelDeliveryInstrumentation({
    recordInputs,
    stateStore: input.stateStore,
  });

  const onStepMetadata = (event: InstrumentationStepAttemptMetadataEvent): void => {
    const attempt = steps.get(event.scope.attemptId);
    if (attempt === undefined) return;
    // Vercel AI Gateway reports per-call cost in providerMetadata.gateway;
    // attributes exist only when it was actually the gateway serving the call.
    const cost = readGatewayCostData(event.providerMetadata);
    if (cost !== undefined) attempt.attributes(gatewayCostAttributes(cost));
  };

  return {
    hook: {
      events: {
        ...channelDeliveries,
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
      const ceiling = { emit: true, ...(await capturePolicy.forOperation(operation.scope)) };
      const inTurn = async () => {
        const turn = await sessionTracing.turnFor(
          operation.scope.sessionId,
          operation.scope.turnId,
          withChannelAudience(ROOT_CONTEXT, operation.scope.channelAudience),
        );
        return turn !== undefined && !turn.finished ? turn.run(execute, ceiling) : execute();
      };
      if (operation.type === "tool.call")
        return tools.runInContext(operation, execute, ceiling, inTurn);
      const model = modelSpans.get(operation.scope.attemptId)?.get(operation.idempotencyKey);
      return model !== undefined && !model.finished ? model.run(execute, ceiling) : inTurn();
    },
  };

  async function drainOpenSpans(event: InstrumentationStepAttemptTerminalEvent): Promise<void> {
    for (const operation of modelSpans.get(event.scope.attemptId)?.values() ?? []) {
      if (event.type === "step.attempt.failed") await operation.fail(event.error);
      else
        await operation.complete({
          outcome: "completed",
          result: { finishReason: "unknown", usage: {} },
        });
    }
    modelSpans.delete(event.scope.attemptId);
  }
}
