import { traceStepIndex } from "#instrumentation/scope.js";
import { attemptIdempotencyKey } from "#instrumentation/lifecycle.js";
import { ROOT_CONTEXT, context, trace } from "#compiled/@opentelemetry/api/index.js";

import type { AgentTraceStateStore } from "#tracing/eve/agent-trace-state.js";
import { createAgentApprovalInstrumentation } from "#tracing/eve/agent-approval-instrumentation.js";
import { createAgentChannelDeliveryInstrumentation } from "#tracing/eve/agent-channel-delivery-instrumentation.js";
import { createAgentToolInstrumentation } from "#tracing/eve/agent-tool-instrumentation.js";
import { eveActivationMetadata } from "#tracing/eve/metadata.js";
import { createAgentMemoryInstrumentation } from "#tracing/eve/agent-memory-instrumentation.js";
import { createEveSessionTracing } from "#tracing/eve/session.js";
import type { TraceCapturePolicy } from "#tracing/eve/otel-declaration.js";
import { isSampledTrace } from "#shared/trace-policy.js";
import { createEveCapturePolicy } from "#tracing/eve/policy.js";
import { withChannelAudience } from "#tracing/eve/channel-audience-context.js";
import type {
  InstrumentationScope,
  InstrumentationModelStartedEvent,
  InstrumentationModelTerminalEvent,
  InstrumentationContextRunner,
  InstrumentationModelCallTerminalEvent,
  InstrumentationModelCallStartedEvent,
  InstrumentationProviderDefinition,
  InstrumentationSessionStartedEvent,
  InstrumentationTraceSeed,
  InstrumentationSessionEndedEvent,
  InstrumentationTurnStartedEvent,
} from "#instrumentation/lifecycle.js";
import { resolveInstrumentationEnvironment } from "#internal/application/dev-environment.js";
import type { ConversationEnvironment } from "#shared/conversation-context.js";
import { createEveTracing } from "#tracing/eve/operation-input.js";
import {
  gatewayCostAttributes,
  gatewayRoutingAttributes,
  readGatewayCostData,
} from "#tracing/eve/gateway.js";
import type {
  AgentSpanIdGenerator,
  AgentTelemetry,
  AttemptOperation,
  ModelOperation,
} from "#compiled/@vercel/agent-runs/index.js";
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
  const capturePolicy = createEveCapturePolicy({
    stateStore: input.stateStore,
    environment,
    recordInputs,
    recordOutputs,
  });
  // Attempts run in one process; a lost serverless worker retries the whole step.
  const steps = new Map<string, AttemptOperation>();
  const modelSpans = new Map<string, Map<string, ModelOperation>>();
  const sessionTracing = createEveSessionTracing({ ...input, environment, tracing, capturePolicy });
  const { prepareSessionTrace, prepareTurnTrace } = sessionTracing;

  /** The attempt in its turn's tree, hydrating it when another process started it. */
  async function attemptFor(scope: InstrumentationScope) {
    const known = steps.get(attemptIdempotencyKey(scope));
    if (known !== undefined) return known;
    const stepIndex = traceStepIndex(scope);
    if (scope.turnId === undefined || stepIndex === undefined) return undefined;
    const turn = await sessionTracing.turnFor(
      scope.sessionId,
      scope.turnId,
      withChannelAudience(ROOT_CONTEXT, scope.channelAudience),
    );
    const index = { stepIndex, attempt: scope.attempt };
    return turn?.findAttempt(index) ?? (turn?.finished === false ? turn.attempt(index) : undefined);
  }

  const tools = createAgentToolInstrumentation({
    tracing,
    attemptFor,
    stepFor: (scope) => steps.get(attemptIdempotencyKey(scope)),
    recordInputs,
    recordOutputs,
    stateStore: input.stateStore,
  });
  const approvals = createAgentApprovalInstrumentation({
    tracing,
    actionStateFor: tools.stateFor,
  });
  const memory = createAgentMemoryInstrumentation({ ...input, environment, tracing });

  function turnState(scope: { sessionId: string; turnId: string }) {
    return input.stateStore.get("turn", JSON.stringify([scope.sessionId, scope.turnId]));
  }

  const onSessionStarted = async (event: InstrumentationSessionStartedEvent): Promise<void> => {
    await prepareSessionTrace(event);
  };

  const onTurnStarted = async (event: InstrumentationTurnStartedEvent): Promise<void> => {
    await prepareTurnTrace(event);
  };

  const onStepStarted = async (event: InstrumentationModelStartedEvent): Promise<void> => {
    const stepIndex = traceStepIndex(event.scope);
    if (event.scope.turnId === undefined || stepIndex === undefined) return;
    const turn = await turnState({ sessionId: event.scope.sessionId, turnId: event.scope.turnId });
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
      stepIndex,
      attempt: event.scope.attempt,
      runtimeContext: event.runtimeContext,
      channel: eveActivationMetadata({ session, turn, sessionId: event.scope.sessionId }).channel,
      links:
        activeSpanContext === undefined || activeSpanContext.traceId === turn.context.traceId
          ? undefined
          : [{ relationship: "execution.delivery", context: activeSpanContext }],
    });
    steps.set(attemptIdempotencyKey(event.scope), attempt);
  };

  const onStepTerminal = async (event: InstrumentationModelTerminalEvent): Promise<void> => {
    const failure = attemptFailed(event) ? { error: event.error } : undefined;
    await drainOpenSpans(event);
    await tools.drain(attemptIdempotencyKey(event.scope), failure);
    const attempt =
      steps.get(attemptIdempotencyKey(event.scope)) ?? (await attemptFor(event.scope));
    steps.delete(attemptIdempotencyKey(event.scope));
    if (failure !== undefined) {
      // A failed attempt also fails the tool calls it dispatched.
      await attempt?.fail(failure.error);
      await tools.forgetAttempt(event.scope);
    } else await attempt?.complete();
  };

  const onSessionEnded = async (event: InstrumentationSessionEndedEvent): Promise<void> => {
    await sessionTracing.sessionEnded(event);
    await tools.deleteForSession(event.sessionId);
    await input.stateStore.delete("session", event.sessionId);
  };

  const onModelCallStarted = async (event: InstrumentationModelCallStartedEvent): Promise<void> => {
    const attempt = steps.get(attemptIdempotencyKey(event.scope));
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
    let models = modelSpans.get(attemptIdempotencyKey(event.scope));
    if (models === undefined)
      modelSpans.set(attemptIdempotencyKey(event.scope), (models = new Map()));
    models.set(event.idempotencyKey, operation);
  };

  const onModelCallTerminal = async (
    event: InstrumentationModelCallTerminalEvent,
  ): Promise<void> => {
    const attempt = steps.get(attemptIdempotencyKey(event.scope));
    if (event.outcome === "completed" && attempt !== undefined) {
      // Vercel AI Gateway reports per-call cost and session affinity routing in providerMetadata.gateway;
      // attributes exist only when it was actually the gateway serving the call.
      const cost = readGatewayCostData(event.providerMetadata);
      if (cost !== undefined) attempt.attributes(gatewayCostAttributes(cost));
      const routing = gatewayRoutingAttributes(event.providerMetadata);
      if (routing !== undefined) attempt.attributes(routing);
    }
    const models = modelSpans.get(attemptIdempotencyKey(event.scope));
    const operation = models?.get(event.idempotencyKey);
    models?.delete(event.idempotencyKey);
    if (operation === undefined) return;
    if (event.outcome === "failed") await operation.fail(event.error);
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

  return {
    hook: {
      events: {
        ...channelDeliveries,
        ...approvals,
        "model.settled": onStepTerminal,

        "model.retried": onStepTerminal,
        "model.started": onStepStarted,
        "model.call.settled": onModelCallTerminal,

        "model.call.started": onModelCallStarted,
        "session.ended": onSessionEnded,
        "session.started": onSessionStarted,
        ...tools.events,
        "turn.settled": sessionTracing.turnSettled,
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
        if (operation.scope.turnId === undefined) return execute();
        const turn = await sessionTracing.turnFor(
          operation.scope.sessionId,
          operation.scope.turnId,
          withChannelAudience(ROOT_CONTEXT, operation.scope.channelAudience),
        );
        if (turn !== undefined && !turn.finished) return turn.run(execute, ceiling);
        // Third-party spans, such as MCP calls, must not record a dropped turn's work.
        const { sessionId, turnId } = operation.scope;
        return input.telemetry.suppressed !== undefined &&
          (await sessionTracing.dropped(sessionId, turnId))
          ? input.telemetry.suppressed(execute)
          : execute();
      };
      if (operation.type === "tool.call")
        return tools.runInContext(operation, execute, ceiling, inTurn);
      const model = modelSpans
        .get(attemptIdempotencyKey(operation.scope))
        ?.get(operation.idempotencyKey);
      return model !== undefined && !model.finished ? model.run(execute, ceiling) : inTurn();
    },
  };

  async function drainOpenSpans(event: InstrumentationModelTerminalEvent): Promise<void> {
    for (const operation of modelSpans.get(attemptIdempotencyKey(event.scope))?.values() ?? []) {
      if (attemptFailed(event)) await operation.fail(event.error);
      else
        await operation.complete({
          outcome: "completed",
          result: { finishReason: "unknown", usage: {} },
        });
    }
    modelSpans.delete(attemptIdempotencyKey(event.scope));
  }
}

/** A retry or an unfinished run fails its attempt; a cancelled turn stopped it on purpose. */
function attemptFailed(event: InstrumentationModelTerminalEvent): boolean {
  return (
    event.type === "model.retried" ||
    (event.outcome !== "completed" && event.outcome !== "cancelled")
  );
}
