import type { Telemetry, TelemetryOptions } from "ai";
import { context as otelContext, trace } from "#compiled/@opentelemetry/api/index.js";

import type { InstrumentationEvents } from "#public/instrumentation/index.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";
import { shouldCaptureInstrumentationContent } from "#shared/instrumentation-content.js";
import type {
  InstrumentationAttemptScope,
  InstrumentationContextRunner,
  InstrumentationHooks,
  InstrumentationSessionStartedEvent,
  InstrumentationTraceContext,
  InstrumentationTraceSeed,
  InstrumentationTurnStartedEvent,
} from "#instrumentation/lifecycle.js";
import { attemptIdempotencyKey } from "#instrumentation/lifecycle.js";
import {
  buildTelemetryRuntimeContext,
  snapshotInstrumentationRuntimeContext,
  type BuildTelemetryRuntimeContextInput,
} from "#instrumentation/runtime-context.js";
import {
  ensureOtelIntegration,
  getRegisteredTelemetryIntegrations,
} from "#instrumentation/ai-sdk-telemetry.js";
import { createAiSdkHookBridge } from "#instrumentation/ai-sdk-hook-bridge.js";
import {
  createInstrumentationHandleEvent,
  publishInputResolutions,
  type CreateInstrumentationHandleEventInput,
} from "#instrumentation/native-events.js";
import type { ResolvedInputBatch } from "#harness/input-requests.js";
import type { HandleEventFn } from "#harness/types.js";
import {
  instrumentChannelDelivery,
  type ChannelDeliveryStartInstrumentation,
  type ChannelDeliveryTerminalInstrumentation,
} from "#instrumentation/channel-delivery.js";
import { createLogger, recordErrorOnSpan } from "#internal/logging.js";
import {
  prepareTurnTraceContext,
  type PrepareTurnTraceContextInput,
} from "#instrumentation/prepare-trace-context.js";
import type { RuntimeTraceContext } from "#protocol/message.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { OtelHarnessSettings, RuntimeContextResolver } from "#tracing/otel-declaration.js";
import type { SessionTraceSeed } from "#context/keys.js";
import { contextStorage, type ContextContainer } from "#context/container.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  InitiatorAuthKey,
  OtelTraceEnabledKey,
  ParentCallIdKey,
  ParentSessionKey,
  ParentTraceContextKey,
  SessionTraceSeedKey,
} from "#context/keys.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import {
  isSampledTrace,
  resolveTracePolicy,
  resolveTracePolicyDecision,
} from "#tracing/sampled-trace.js";
import { resolveParentLineage } from "#instrumentation/parent-lineage.js";
import { summarizeInstrumentationPrincipal } from "#instrumentation/principal-summary.js";
import type { ChannelInstrumentationProjection, SessionTraceContext } from "#channel/types.js";
import { readSessionTraceDecision } from "#tracing/agent-trace-context-store.js";
import { readInstrumentationDecision } from "#shared/instrumentation-decision.js";
import {
  applyLiveDeliveryAudienceCeiling,
  formatTraceContentCeiling,
  readForwardedTraceAssertion,
  resolveForwardedTraceSeed,
} from "#shared/forwarded-trace-policy.js";
import { resolveInitialSessionTraceSeed } from "#instrumentation/session-trace-seed.js";

const INSTRUMENTATION_RUNTIME_KEY = Symbol.for("eve.instrumentation-runtime");
const TURN_TRACE_STATE_KEY = "eve.harness.turnTrace";
const log = createLogger("instrumentation.runtime");

interface InstrumentedStepSession {
  readonly sessionId: string;
  readonly state?: Readonly<Record<string, unknown>>;
}

export interface InstrumentationStepScope<TSession> {
  readonly createHandleEvent: (
    input: Omit<
      CreateInstrumentationHandleEventInput,
      | "agentName"
      | "channelAudience"
      | "channelKind"
      | "hooks"
      | "parentLineage"
      | "parentTraceContext"
      | "rootSessionId"
      | "sessionId"
    >,
  ) => HandleEventFn | undefined;
  readonly prepareAttempt: (input: {
    readonly attemptIndex: number;
    readonly runtimeContext?: Readonly<Record<string, unknown>>;
    readonly stepIndex: number;
    readonly turnId: string;
  }) => PreparedInstrumentationAttempt;
  readonly preparePreamble: (
    input: Omit<
      PrepareTurnTraceContextInput,
      | "agentName"
      | "channelAudience"
      | "channelType"
      | "instrumentation"
      | "parentLineage"
      | "parentTraceContext"
      | "rootSessionId"
      | "sessionId"
      | "traceSeed"
    >,
  ) => Promise<RuntimeTraceContext | undefined>;
  readonly publishInputResolutions: (input: {
    readonly batch: ResolvedInputBatch;
    readonly sessionId: string;
  }) => Promise<void>;
  readonly recordError: (error: unknown) => void;
  readonly resolveRuntimeContext: (
    input: Omit<
      BuildTelemetryRuntimeContextInput,
      "capturesContent" | "context" | "providerResolvers" | "stepStartedResolver"
    >,
  ) => Record<string, unknown> | undefined;
  readonly session: TSession;
  readonly setTurnId: (turnId: string) => void;
  readonly telemetry: () => TelemetryOptions | undefined;
  readonly traceContext?: InstrumentationTraceContext;
}

export interface PreparedInstrumentationAttempt {
  readonly complete: () => Promise<void>;
  readonly fail: (error: unknown) => Promise<void>;
  readonly scope: InstrumentationAttemptScope;
  readonly telemetry: TelemetryOptions | undefined;
}

export type InstrumentationAttempt = InstrumentationAttemptScope;

export interface BoundInstrumentationSession {
  readonly agentName: string;
  readonly rootSessionId: string;
  readonly sessionId: string;
}

/** Process-wide runtime consumed by every harness execution surface. */
export interface InstrumentationRuntime {
  readonly forceFlush: () => Promise<void>;
  readonly hooks: InstrumentationHooks;
  readonly idGenerator?: AgentSpanIdGenerator;
  readonly instrumentationProviders?: boolean;
  readonly ownsAgentSpans?: boolean;
  readonly prepareSessionTrace?: (
    event: InstrumentationSessionStartedEvent,
  ) => Promise<InstrumentationTraceSeed>;
  readonly prepareTurnTrace?: (
    event: InstrumentationTurnStartedEvent,
  ) => Promise<InstrumentationTraceSeed>;
  otelSettings: OtelHarnessSettings | undefined;
  readonly runtimeContextResolvers?: readonly RuntimeContextResolver[];
  readonly runInContext: InstrumentationContextRunner;
  /** Whether the installed OTel sampler would record a trace with this id. */
  readonly samplesTrace?: (traceId: string) => boolean;
  readonly shutdown: () => Promise<void>;
  stepStartedRuntimeContextResolver?: InstrumentationEvents["step.started"];
}

/** Worker-bound instrumentation operations consumed by one session execution. */
export interface SessionInstrumentation {
  readonly runStep: <TSession extends InstrumentedStepSession, TResult>(
    input: {
      readonly environment: string;
      readonly eveVersion: string;
      readonly hasInput: boolean;
      readonly session: TSession;
    },
    execute: (scope: InstrumentationStepScope<TSession>) => Promise<TResult>,
  ) => Promise<TResult>;
}

export interface ExecutionInstrumentation {
  readonly createHandleEvent: (input: {
    readonly handleEvent?: HandleEventFn;
    readonly turnId?: string;
  }) => HandleEventFn | undefined;
  readonly flush: () => Promise<void>;
  readonly instrumentChannelDelivery: (
    input:
      | Omit<ChannelDeliveryStartInstrumentation, "hooks" | "policyAgentName">
      | Omit<ChannelDeliveryTerminalInstrumentation, "hooks">,
  ) => Promise<void>;
  readonly prepareExecution: () => SessionInstrumentation;
  readonly preparePreamble: InstrumentationStepScope<never>["preparePreamble"];
}

export function bindInstrumentationRuntime(
  runtime: InstrumentationRuntime | undefined,
  ctx: ContextContainer,
  boundSession: BoundInstrumentationSession,
): ExecutionInstrumentation | undefined {
  if (runtime === undefined) return undefined;
  const baseHooks = runtime.hooks;
  const readSessionContext = () => {
    const context = contextStorage.getStore() ?? ctx;
    const storedTraceSeed = context.get(SessionTraceSeedKey);
    const resolvedTraceState = resolveForwardedTraceSeed(storedTraceSeed);
    const traceSeed =
      storedTraceSeed === undefined || resolvedTraceState === undefined
        ? undefined
        : { ...storedTraceSeed, ...resolvedTraceState };
    const parentTraceContext = context.get(ParentTraceContextKey);
    return {
      currentPrincipal: summarizeInstrumentationPrincipal(context.get(AuthKey)),
      channel: context.get(ChannelKey),
      context,
      instrumentation: context.get(ChannelInstrumentationKey),
      forwardedTracePolicy: readForwardedTraceAssertion(
        traceSeed?.forwardedTracePolicy ?? parentTraceContext?.forwardedTracePolicy,
      ),
      parent: context.get(ParentSessionKey),
      parentCallId: context.get(ParentCallIdKey),
      parentTraceContext,
      initiatorPrincipal: summarizeInstrumentationPrincipal(context.get(InitiatorAuthKey)),
      traceSeed,
    };
  };
  const bindHooks = (sessionContext: ReturnType<typeof readSessionContext>) => {
    const channel = sessionContext.instrumentation;
    return (
      baseHooks.forTrace?.({
        agentName: boundSession.agentName,
        audience: normalizeChannelAudience(channel?.metadata.audience),
        channelType: channel?.channelType,
      }) ?? baseHooks
    );
  };
  const captureExecutionRuntime = () => {
    const otelSettings = runtime.otelSettings;
    const ownsAgentSpans = runtime.ownsAgentSpans === true;
    if (otelSettings !== undefined && !ownsAgentSpans) ensureOtelIntegration();
    return {
      ownsAgentSpans,
      otelSettings,
      runtimeContextResolvers: runtime.runtimeContextResolvers,
      stepStartedRuntimeContextResolver: runtime.stepStartedRuntimeContextResolver,
      tracer: otelSettings === undefined ? undefined : trace.getTracer("eve"),
    };
  };
  const preparePreamble = (
    input: Parameters<ExecutionInstrumentation["preparePreamble"]>[0],
    sessionContext: ReturnType<typeof readSessionContext>,
  ) => {
    const channel = sessionContext.instrumentation;
    const audience = normalizeChannelAudience(channel?.metadata.audience);
    return prepareTurnTraceContext({
      ...input,
      agentName: boundSession.agentName,
      channelAudience: audience,
      channelType: channel?.channelType,
      instrumentation: runtime,
      parentLineage: resolveParentLineage(
        sessionContext.parent === undefined
          ? undefined
          : {
              ...sessionContext.parent,
              callId: sessionContext.parentCallId ?? sessionContext.parent.callId,
            },
        sessionContext.channel,
      ),
      currentPrincipal: sessionContext.currentPrincipal,
      initiatorPrincipal: sessionContext.initiatorPrincipal,
      parentTraceContext: sessionContext.parentTraceContext,
      rootSessionId: sessionContext.parent?.rootSessionId ?? boundSession.rootSessionId,
      sessionId: boundSession.sessionId,
      traceSeed: sessionContext.traceSeed,
    });
  };
  const prepareExecution = (): SessionInstrumentation => {
    const executionRuntime = captureExecutionRuntime();
    return {
      runStep: async (input, execute) => {
        const policyContext = readSessionContext();
        const hooks = bindHooks(policyContext);
        const settings = executionRuntime.otelSettings;
        const decision = resolveStepInstrumentationDecision(
          settings,
          boundSession.agentName,
          policyContext.instrumentation,
          policyContext.traceSeed ?? policyContext.parentTraceContext,
          readSessionTraceDecision(policyContext.context, boundSession.sessionId),
        );
        const tracer = executionRuntime.tracer;
        const attributes: Record<string, string> = {
          "eve.environment": input.environment,
          "eve.session.id": input.session.sessionId,
          "eve.version": input.eveVersion,
        };
        const functionId = settings?.functionId ?? boundSession.agentName;
        if (functionId) attributes["ai.telemetry.functionId"] = functionId;
        let turnSpan =
          tracer !== undefined &&
          !executionRuntime.ownsAgentSpans &&
          decision?.action !== "drop" &&
          input.hasInput
            ? tracer.startSpan("ai.eve.turn", { attributes })
            : undefined;
        const spanContext = turnSpan?.spanContext();
        const session =
          spanContext === undefined
            ? input.session
            : ({
                ...input.session,
                state: {
                  ...input.session.state,
                  [TURN_TRACE_STATE_KEY]: {
                    spanId: spanContext.spanId,
                    traceFlags: spanContext.traceFlags,
                    traceId: spanContext.traceId,
                  },
                },
              } as typeof input.session);
        let parentContext =
          turnSpan === undefined ? undefined : trace.setSpan(otelContext.active(), turnSpan);
        if (parentContext === undefined && tracer !== undefined) {
          const stored = input.session.state?.[TURN_TRACE_STATE_KEY] as
            | { readonly spanId: string; readonly traceFlags: number; readonly traceId: string }
            | undefined;
          if (stored !== undefined) {
            parentContext = trace.setSpan(
              otelContext.active(),
              trace.wrapSpanContext({ ...stored, isRemote: true }),
            );
          }
        }

        const sessionContext = readSessionContext();
        const runtimeContextSnapshot = snapshotInstrumentationRuntimeContext(
          sessionContext.context,
        );
        const channel = sessionContext.instrumentation;
        const audience = normalizeChannelAudience(channel?.metadata.audience);
        const capturesContent = shouldCaptureInstrumentationContent(audience);
        const effectiveDecision =
          decision === undefined
            ? decision
            : applyLiveDeliveryAudienceCeiling(
                decision,
                audience,
                sessionContext.forwardedTracePolicy,
              );
        const capturesRuntimeContextInput =
          effectiveDecision === undefined
            ? capturesContent
            : effectiveDecision.action === "record" && effectiveDecision.recordInputs;
        const dropsTrace = decision?.action === "drop";
        const content = {
          recordInputs:
            !dropsTrace &&
            (effectiveDecision?.action === "record"
              ? effectiveDecision.recordInputs
              : capturesContent) &&
            (settings?.recordInputs ?? false),
          recordOutputs:
            !dropsTrace &&
            (effectiveDecision?.action === "record"
              ? effectiveDecision.recordOutputs
              : capturesContent) &&
            (settings?.recordOutputs ?? false),
        };
        const telemetry = (telemetryInput: {
          readonly bridgeIntegration?: Telemetry;
          readonly runtimeContext?: Readonly<Record<string, unknown>>;
        }): TelemetryOptions | undefined => {
          if (settings === undefined && telemetryInput.bridgeIntegration === undefined) {
            return undefined;
          }
          const includeRuntimeContext: Record<string, true> = {};
          for (const key of Object.keys(telemetryInput.runtimeContext ?? {})) {
            includeRuntimeContext[key] = true;
          }
          const sanitizeEveOtelErrors =
            settings !== undefined && !(content.recordInputs && content.recordOutputs);
          const integrations = () =>
            getRegisteredTelemetryIntegrations({
              ...(executionRuntime.ownsAgentSpans
                ? { excludeEveOtelIntegration: true }
                : undefined),
              sanitizeEveOtelErrors,
            });
          return {
            functionId: settings?.functionId ?? boundSession.agentName,
            includeRuntimeContext,
            integrations:
              telemetryInput.bridgeIntegration === undefined
                ? sanitizeEveOtelErrors
                  ? [...integrations()]
                  : undefined
                : [telemetryInput.bridgeIntegration, ...integrations()],
            isEnabled: true,
            recordInputs: content.recordInputs,
            recordOutputs: content.recordOutputs,
          };
        };
        const run = () =>
          execute({
            createHandleEvent: (eventInput) =>
              createInstrumentationHandleEvent({
                ...eventInput,
                agentName: boundSession.agentName,
                channelAudience: audience,
                channelKind: channel?.kind,
                hooks,
                parentLineage: resolveParentLineage(
                  sessionContext.parent === undefined
                    ? undefined
                    : {
                        ...sessionContext.parent,
                        callId: sessionContext.parentCallId ?? sessionContext.parent.callId,
                      },
                  sessionContext.channel,
                ),
                parentTraceContext: sessionContext.parentTraceContext,
                rootSessionId: sessionContext.parent?.rootSessionId,
                sessionId: boundSession.sessionId,
              }),
            prepareAttempt: (attemptInput) => {
              const scope: InstrumentationAttemptScope = {
                attemptId: `${boundSession.sessionId}:${attemptInput.turnId}:${attemptInput.stepIndex}:${attemptInput.attemptIndex}`,
                attemptIndex: attemptInput.attemptIndex,
                channelAudience: audience,
                functionId: settings?.functionId ?? boundSession.agentName,
                rootSessionId: sessionContext.parent?.rootSessionId ?? boundSession.sessionId,
                sessionId: boundSession.sessionId,
                stepIndex: attemptInput.stepIndex,
                turnId: attemptInput.turnId,
              };
              const bridgeIntegration = createAiSdkHookBridge(
                scope,
                hooks,
                runtime.runInContext,
                attemptInput.runtimeContext,
              );
              return {
                complete: () =>
                  hooks.publish({
                    idempotencyKey: attemptIdempotencyKey(scope),
                    scope,
                    type: "step.attempt.completed",
                  }),
                fail: (error) =>
                  hooks.publish({
                    error,
                    idempotencyKey: attemptIdempotencyKey(scope),
                    scope,
                    type: "step.attempt.failed",
                  }),
                scope,
                telemetry: telemetry({
                  bridgeIntegration,
                  runtimeContext: attemptInput.runtimeContext,
                }),
              };
            },
            preparePreamble: (preambleInput) => preparePreamble(preambleInput, sessionContext),
            publishInputResolutions: (resolutionInput) =>
              publishInputResolutions({ ...resolutionInput, hooks }),
            recordError: (error) => {
              if (turnSpan !== undefined) recordErrorOnSpan(turnSpan, error);
            },
            resolveRuntimeContext: (runtimeContextInput) => {
              return buildTelemetryRuntimeContext({
                ...runtimeContextInput,
                capturesContent: capturesRuntimeContextInput,
                context: runtimeContextSnapshot,
                providerResolvers: executionRuntime.runtimeContextResolvers,
                stepStartedResolver: executionRuntime.stepStartedRuntimeContextResolver,
              });
            },
            session,
            setTurnId: (turnId) => turnSpan?.setAttribute("eve.turn.id", turnId),
            telemetry: () => telemetry({}),
            traceContext:
              spanContext === undefined || !isValidSpanContext(spanContext)
                ? undefined
                : {
                    spanId: spanContext.spanId,
                    traceFlags: spanContext.traceFlags,
                    traceId: spanContext.traceId,
                  },
          });
        try {
          return parentContext === undefined
            ? await run()
            : await otelContext.with(parentContext, run);
        } finally {
          turnSpan?.end();
          turnSpan = undefined;
        }
      },
    };
  };
  return {
    createHandleEvent: (input) => {
      const sessionContext = readSessionContext();
      return createInstrumentationHandleEvent({
        agentName: boundSession.agentName,
        channelKind: sessionContext.instrumentation?.kind,
        handleEvent: input.handleEvent,
        hooks: bindHooks(sessionContext),
        sessionId: boundSession.sessionId,
        turnId: input.turnId,
      });
    },
    flush: runtime.forceFlush,
    instrumentChannelDelivery: (input) =>
      instrumentChannelDelivery({
        ...input,
        hooks: baseHooks,
        policyAgentName: boundSession.agentName,
      }),
    prepareExecution,
    preparePreamble: (input) => preparePreamble(input, readSessionContext()),
  };
}

export function bindSessionInstrumentation(input: {
  readonly agentName: string;
  readonly ctx: ContextContainer;
  readonly rootSessionId: string;
  readonly sessionId: string;
}): ExecutionInstrumentation | undefined {
  return bindInstrumentationRuntime(getInstrumentationRuntime(), input.ctx, {
    agentName: input.agentName,
    rootSessionId: input.rootSessionId,
    sessionId: input.sessionId,
  });
}

export function initializeSessionInstrumentation(input: {
  readonly agentName: string;
  readonly ctx: ContextContainer;
  readonly parentTraceContext?: SessionTraceContext;
  readonly traceSeed?: SessionTraceSeed;
}): void {
  const runtime = getInstrumentationRuntime();
  const channel = input.ctx.get(ChannelInstrumentationKey);
  const forwardedTracePolicy = readForwardedTraceAssertion(
    input.traceSeed?.forwardedTracePolicy ?? input.parentTraceContext?.forwardedTracePolicy,
  );
  const audience =
    forwardedTracePolicy?.originAudience ?? normalizeChannelAudience(channel?.metadata.audience);
  const traceSeed = resolveInitialSessionTraceSeed({
    agentName: input.agentName,
    audience,
    channelType: channel?.channelType,
    forwardedTracePolicy,
    parentTraceContext: input.parentTraceContext,
    runtime,
    seed: input.traceSeed,
  });
  if (traceSeed !== undefined) {
    const legacyParentContext =
      input.traceSeed === undefined && input.parentTraceContext !== undefined;
    if (legacyParentContext) {
      input.ctx.set(ParentTraceContextKey, {
        ...input.parentTraceContext,
        decision: traceSeed.decision,
        forwardedTracePolicy: traceSeed.forwardedTracePolicy,
        traceFlags: traceSeed.traceFlags,
      });
    } else {
      input.ctx.set(SessionTraceSeedKey, traceSeed);
    }
    if (forwardedTracePolicy !== undefined) {
      log.info("resolved forwarded trace policy", {
        ceilingEffective:
          traceSeed.decision?.action === "record"
            ? formatTraceContentCeiling(traceSeed.decision)
            : "drop",
        ceilingIn: formatTraceContentCeiling(forwardedTracePolicy.ceiling),
        originAudience: forwardedTracePolicy.originAudience,
      });
    }
    if (
      !legacyParentContext &&
      forwardedTracePolicy !== undefined &&
      input.parentTraceContext !== undefined
    ) {
      const parentTraceContext = { ...input.parentTraceContext, decision: traceSeed.decision };
      delete parentTraceContext.forwardedTracePolicy;
      input.ctx.set(ParentTraceContextKey, parentTraceContext);
    }
  }
  input.ctx.set(OtelTraceEnabledKey, runtime?.prepareSessionTrace !== undefined);
}

function resolveStepInstrumentationDecision(
  settings: OtelHarnessSettings | undefined,
  agentName: string,
  channel: ChannelInstrumentationProjection | undefined,
  traceSeed: SessionTraceSeed | undefined,
  persisted: InstrumentationDecision | undefined,
): InstrumentationDecision | undefined {
  if (settings === undefined) return undefined;
  if (traceSeed?.decision !== undefined) return readInstrumentationDecision(traceSeed.decision);
  if (persisted !== undefined) return persisted;
  const audience = normalizeChannelAudience(channel?.metadata.audience);
  if (traceSeed !== undefined) {
    return resolveTracePolicyDecision(isSampledTrace(traceSeed), audience);
  }
  return resolveTracePolicy(settings.tracePolicy, {
    agentName,
    audience,
    channelType: channel?.channelType,
  });
}

function isValidSpanContext(spanContext: {
  readonly spanId: string;
  readonly traceId: string;
}): boolean {
  return (
    /^[0-9a-f]{32}$/u.test(spanContext.traceId) &&
    spanContext.traceId !== "00000000000000000000000000000000" &&
    /^[0-9a-f]{16}$/u.test(spanContext.spanId) &&
    spanContext.spanId !== "0000000000000000"
  );
}

type InstrumentationGlobal = typeof globalThis & {
  [INSTRUMENTATION_RUNTIME_KEY]?: InstrumentationRuntime;
};

const globalRuntime = globalThis as InstrumentationGlobal;

/** Registers the process instrumentation runtime before agent execution begins. */
export function registerInstrumentationRuntime(
  runtime: InstrumentationRuntime,
): InstrumentationRuntime {
  const existing = globalRuntime[INSTRUMENTATION_RUNTIME_KEY];
  if (existing !== undefined) {
    // A legacy config may reload without taking ownership from the installed runtime.
    existing.otelSettings = runtime.otelSettings;
    return existing;
  }
  globalRuntime[INSTRUMENTATION_RUNTIME_KEY] = runtime;
  return runtime;
}

/** Returns the process instrumentation runtime, when one was installed. */
export function getInstrumentationRuntime(): InstrumentationRuntime | undefined {
  return globalRuntime[INSTRUMENTATION_RUNTIME_KEY];
}
