import type { Telemetry } from "ai";

import { createLogger, formatError } from "#internal/logging.js";

type TelemetryEvent<TKey extends keyof Telemetry> = Parameters<NonNullable<Telemetry[TKey]>>[0];

/** Stable eve identity for one actual model attempt. */
export interface InstrumentationAttemptScope {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly functionId?: string;
  readonly rootSessionId?: string;
  readonly sessionId: string;
  readonly stepIndex: number;
  readonly turnId: string;
}

export interface InstrumentationAttemptStartedEvent {
  readonly type: "attempt.started";
  readonly scope: InstrumentationAttemptScope;
  readonly operation: TelemetryEvent<"onStart">;
  readonly step: TelemetryEvent<"onStepStart">;
}

export interface InstrumentationSessionStartedEvent {
  readonly type: "session.started";
  readonly agentName?: string;
  readonly channelKind?: string;
  readonly parentTraceContext?: InstrumentationTraceContext;
  readonly rootSessionId: string;
  readonly sessionId: string;
}

export interface InstrumentationTraceContext {
  readonly spanId: string;
  readonly traceFlags: number;
  readonly traceId: string;
}

/**
 * Which tool call dispatched a subagent child. The trace structure alone
 * cannot say: one turn's children all parent to the same window.
 */
export interface InstrumentationParentLineage {
  readonly callId: string;
  readonly sessionId: string;
  readonly subagentName?: string;
  readonly turnId: string;
}

export interface InstrumentationSessionTransitionEvent {
  readonly type: "session.completed" | "session.failed" | "session.waiting";
  readonly error?: unknown;
  readonly sessionId: string;
  readonly turnId?: string;
}

export interface InstrumentationTurnStartedEvent {
  readonly type: "turn.started";
  readonly parentLineage?: InstrumentationParentLineage;
  readonly parentTraceContext?: InstrumentationTraceContext;
  readonly rootSessionId: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface InstrumentationTurnTerminalEvent {
  readonly type: "turn.cancelled" | "turn.completed" | "turn.failed";
  readonly error?: unknown;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface InstrumentationAttemptTerminalEvent {
  readonly type: "attempt.completed" | "attempt.failed";
  readonly error?: unknown;
  readonly scope: InstrumentationAttemptScope;
}

/**
 * Provider metadata for one completed step, as reported by the AI SDK
 * (`StepResult.providerMetadata`). Carries Vercel AI Gateway cost data when
 * the request went through the gateway; absent for other providers.
 */
export interface InstrumentationAttemptMetadataEvent {
  readonly type: "attempt.metadata";
  readonly scope: InstrumentationAttemptScope;
  readonly providerMetadata: Readonly<Record<string, unknown>>;
}

export interface InstrumentationModelCallStartedEvent {
  readonly type: "model.call.started";
  readonly id: string;
  readonly scope: InstrumentationAttemptScope;
  readonly source: TelemetryEvent<"onLanguageModelCallStart">;
}

export interface InstrumentationModelCallCompletedEvent {
  readonly type: "model.call.completed";
  readonly id: string;
  readonly scope: InstrumentationAttemptScope;
  readonly source: TelemetryEvent<"onLanguageModelCallEnd">;
}

export interface InstrumentationModelCallFailedEvent {
  readonly type: "model.call.failed";
  readonly error: unknown;
  readonly id: string;
  readonly scope: InstrumentationAttemptScope;
}

export type InstrumentationModelCallTerminalEvent =
  | InstrumentationModelCallCompletedEvent
  | InstrumentationModelCallFailedEvent;

export interface InstrumentationToolCallStartedEvent {
  readonly type: "tool.call.started";
  readonly id: string;
  readonly scope: InstrumentationAttemptScope;
  readonly source: TelemetryEvent<"onToolExecutionStart">;
}

export interface InstrumentationToolCallCompletedEvent {
  readonly type: "tool.call.completed";
  readonly id: string;
  readonly scope: InstrumentationAttemptScope;
  readonly source: TelemetryEvent<"onToolExecutionEnd">;
}

export interface InstrumentationToolCallFailedEvent {
  readonly type: "tool.call.failed";
  readonly error: unknown;
  readonly id: string;
  readonly scope: InstrumentationAttemptScope;
}

export type InstrumentationToolCallTerminalEvent =
  | InstrumentationToolCallCompletedEvent
  | InstrumentationToolCallFailedEvent;

export interface RelatedLifecycleHook<TStart, TTerminal> {
  readonly before?: (event: TStart) => unknown | PromiseLike<unknown>;
  readonly after?: (event: TTerminal, state: unknown) => void | PromiseLike<void>;
}

/** Internal provider shape mirrored by the future public hook contract. */
export interface InstrumentationProviderDefinition {
  readonly events?: {
    readonly "model.call"?: RelatedLifecycleHook<
      InstrumentationModelCallStartedEvent,
      InstrumentationModelCallTerminalEvent
    >;
    readonly "attempt.started"?: (
      event: InstrumentationAttemptStartedEvent,
    ) => void | PromiseLike<void>;
    readonly "attempt.completed"?: (
      event: InstrumentationAttemptTerminalEvent,
    ) => void | PromiseLike<void>;
    readonly "attempt.failed"?: (
      event: InstrumentationAttemptTerminalEvent,
    ) => void | PromiseLike<void>;
    readonly "attempt.metadata"?: (
      event: InstrumentationAttemptMetadataEvent,
    ) => void | PromiseLike<void>;
    readonly "session.completed"?: (
      event: InstrumentationSessionTransitionEvent,
    ) => void | PromiseLike<void>;
    readonly "session.failed"?: (
      event: InstrumentationSessionTransitionEvent,
    ) => void | PromiseLike<void>;
    readonly "session.started"?: (
      event: InstrumentationSessionStartedEvent,
    ) => void | PromiseLike<void>;
    readonly "session.waiting"?: (
      event: InstrumentationSessionTransitionEvent,
    ) => void | PromiseLike<void>;
    readonly "tool.call"?: RelatedLifecycleHook<
      InstrumentationToolCallStartedEvent,
      InstrumentationToolCallTerminalEvent
    >;
    readonly "turn.cancelled"?: (
      event: InstrumentationTurnTerminalEvent,
    ) => void | PromiseLike<void>;
    readonly "turn.completed"?: (
      event: InstrumentationTurnTerminalEvent,
    ) => void | PromiseLike<void>;
    readonly "turn.failed"?: (event: InstrumentationTurnTerminalEvent) => void | PromiseLike<void>;
    readonly "turn.started"?: (event: InstrumentationTurnStartedEvent) => void | PromiseLike<void>;
  };
}

export interface InstrumentationRelatedEventMap {
  readonly "model.call": {
    readonly start: InstrumentationModelCallStartedEvent;
    readonly terminal: InstrumentationModelCallTerminalEvent;
  };
  readonly "tool.call": {
    readonly start: InstrumentationToolCallStartedEvent;
    readonly terminal: InstrumentationToolCallTerminalEvent;
  };
}

export type InstrumentationRelatedEventName = keyof InstrumentationRelatedEventMap;

export type InstrumentationPointEvent =
  | InstrumentationAttemptStartedEvent
  | InstrumentationAttemptMetadataEvent
  | InstrumentationAttemptTerminalEvent
  | InstrumentationSessionStartedEvent
  | InstrumentationSessionTransitionEvent
  | InstrumentationTurnStartedEvent
  | InstrumentationTurnTerminalEvent;

/** Trusted framework operation for activating context around AI SDK execution. */
export type InstrumentationContextRunner = <T>(
  operation: InstrumentationExecutionOperation,
  execute: () => PromiseLike<T>,
) => PromiseLike<T>;

/** Stable identity supplied only to a trusted framework context runner. */
export type InstrumentationExecutionOperation =
  | {
      readonly id: string;
      readonly scope: InstrumentationAttemptScope;
      readonly type: "model.call";
    }
  | {
      readonly id: string;
      readonly scope: InstrumentationAttemptScope;
      readonly type: "tool.call";
    };

/** Provider-neutral hook operations consumed by the AI SDK bridge. */
export interface InstrumentationHooks {
  after<TKey extends InstrumentationRelatedEventName>(
    name: TKey,
    event: InstrumentationRelatedEventMap[TKey]["terminal"],
  ): Promise<void>;
  before<TKey extends InstrumentationRelatedEventName>(
    name: TKey,
    event: InstrumentationRelatedEventMap[TKey]["start"],
  ): Promise<void>;
  publish(event: InstrumentationPointEvent): Promise<void>;
}

const log = createLogger("harness.instrumentation-lifecycle");

/** Creates failure-isolated hooks backed by an ordered provider list. */
export function createInstrumentationHooks(
  providers: readonly InstrumentationProviderDefinition[],
): InstrumentationHooks {
  const relatedState = new WeakMap<InstrumentationAttemptScope, Map<string, unknown>>();

  const publish = async (event: InstrumentationPointEvent): Promise<void> => {
    for (const provider of providers) {
      const handler = provider.events?.[event.type];
      if (handler === undefined) continue;
      try {
        await (handler as (value: typeof event) => void | PromiseLike<void>)(event);
      } catch (error) {
        warn(event.type, error);
      }
    }
  };

  const before = async <TKey extends InstrumentationRelatedEventName>(
    name: TKey,
    event: InstrumentationRelatedEventMap[TKey]["start"],
  ): Promise<void> => {
    const attemptState = relatedState.get(event.scope) ?? new Map<string, unknown>();
    relatedState.set(event.scope, attemptState);
    for (const [providerIndex, provider] of providers.entries()) {
      const handler = provider.events?.[name]?.before;
      if (handler === undefined) continue;
      try {
        const state = await (handler as (value: typeof event) => unknown)(event);
        attemptState.set(relatedStateKey(providerIndex, event.id), state);
      } catch (error) {
        warn(`${name}.before`, error);
      }
    }
  };

  const after = async <TKey extends InstrumentationRelatedEventName>(
    name: TKey,
    event: InstrumentationRelatedEventMap[TKey]["terminal"],
  ): Promise<void> => {
    const attemptState = relatedState.get(event.scope);
    for (const [providerIndex, provider] of providers.entries()) {
      const handler = provider.events?.[name]?.after;
      const stateKey = relatedStateKey(providerIndex, event.id);
      if (handler === undefined || !attemptState?.has(stateKey)) continue;
      const state = attemptState.get(stateKey);
      attemptState.delete(stateKey);
      try {
        await (handler as (value: typeof event, state: unknown) => void | PromiseLike<void>)(
          event,
          state,
        );
      } catch (error) {
        warn(`${name}.after`, error);
      }
    }
  };

  const warn = (boundary: string, error: unknown): void => {
    log.warn("instrumentation provider failed", { boundary, error: formatError(error) });
  };

  return {
    after,
    before,
    publish,
  };
}

function relatedStateKey(providerIndex: number, operationId: string): string {
  return `${providerIndex}:${operationId}`;
}
