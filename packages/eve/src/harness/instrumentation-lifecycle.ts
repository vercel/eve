import { createLogger, formatError } from "#internal/logging.js";

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

/** The model SDK operation an attempt runs through. */
export interface InstrumentationOperationRef {
  readonly modelId: string;
  readonly operationId: string;
  readonly provider: string;
}

export interface InstrumentationModelRef {
  readonly modelId: string;
  readonly provider: string;
}

/** Token usage for one model call. A field is absent when the provider omits it. */
export interface InstrumentationUsage {
  readonly inputTokenDetails?: {
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  };
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/** Final model input for one call. Message shape stays opaque to this layer. */
export interface InstrumentationModelInput {
  readonly instructions?: unknown;
  readonly messages: readonly unknown[];
}

/**
 * The model response parts eve records. A kind outside this union is dropped
 * when the bridge maps a response, so widening the union is what makes a new
 * kind reachable by a provider.
 */
export type InstrumentationContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | { readonly type: "tool-call"; readonly input: unknown; readonly toolName: string }
  | {
      readonly type: "tool-result";
      readonly input: unknown;
      readonly output: unknown;
      readonly toolName: string;
    }
  | {
      readonly type: "tool-error";
      readonly error: unknown;
      readonly input: unknown;
      readonly toolName: string;
    };

/**
 * What eve dispatched a tool call as. The model sees every action as a tool,
 * so this is the only thing that separates a subagent or remote-agent call
 * from an ordinary tool in a trace.
 */
export type InstrumentationActionKind = "remote-agent-call" | "subagent-call" | "tool-call";

/** How one tool execution ended. */
export type InstrumentationToolOutput =
  | { readonly type: "result"; readonly output: unknown }
  | { readonly type: "error"; readonly error: unknown };

export interface InstrumentationAttemptStartedEvent {
  readonly type: "attempt.started";
  readonly operation: InstrumentationOperationRef;
  readonly scope: InstrumentationAttemptScope;
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
  readonly input: InstrumentationModelInput;
  readonly model: InstrumentationModelRef;
  readonly scope: InstrumentationAttemptScope;
}

export interface InstrumentationModelCallCompletedEvent {
  readonly type: "model.call.completed";
  readonly content: readonly InstrumentationContentPart[];
  readonly finishReason: string;
  readonly id: string;
  readonly scope: InstrumentationAttemptScope;
  readonly usage: InstrumentationUsage;
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
  readonly callId: string;
  readonly id: string;
  readonly input: unknown;
  readonly kind: InstrumentationActionKind;
  readonly scope: InstrumentationAttemptScope;
  readonly toolName: string;
}

export interface InstrumentationToolCallCompletedEvent {
  readonly type: "tool.call.completed";
  readonly id: string;
  readonly output: InstrumentationToolOutput;
  readonly scope: InstrumentationAttemptScope;
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

/**
 * eve balances every start with exactly one terminal — the bridge terminalizes
 * open operations on abort and error, and a retry gets a fresh attempt id — so
 * a provider that needs to carry a handle from a start to its terminal can keep
 * its own map keyed by `event.id` and delete on the terminal.
 */
export type InstrumentationEventHandler<TEvent> = (event: TEvent) => void | PromiseLike<void>;

/** Internal provider shape mirrored by the future public hook contract. */
export interface InstrumentationProviderDefinition {
  readonly events?: {
    readonly "attempt.started"?: InstrumentationEventHandler<InstrumentationAttemptStartedEvent>;
    readonly "attempt.completed"?: InstrumentationEventHandler<InstrumentationAttemptTerminalEvent>;
    readonly "attempt.failed"?: InstrumentationEventHandler<InstrumentationAttemptTerminalEvent>;
    readonly "attempt.metadata"?: InstrumentationEventHandler<InstrumentationAttemptMetadataEvent>;
    readonly "model.call.started"?: InstrumentationEventHandler<InstrumentationModelCallStartedEvent>;
    readonly "model.call.completed"?: InstrumentationEventHandler<InstrumentationModelCallCompletedEvent>;
    readonly "model.call.failed"?: InstrumentationEventHandler<InstrumentationModelCallFailedEvent>;
    readonly "session.completed"?: InstrumentationEventHandler<InstrumentationSessionTransitionEvent>;
    readonly "session.failed"?: InstrumentationEventHandler<InstrumentationSessionTransitionEvent>;
    readonly "session.started"?: InstrumentationEventHandler<InstrumentationSessionStartedEvent>;
    readonly "session.waiting"?: InstrumentationEventHandler<InstrumentationSessionTransitionEvent>;
    readonly "tool.call.started"?: InstrumentationEventHandler<InstrumentationToolCallStartedEvent>;
    readonly "tool.call.completed"?: InstrumentationEventHandler<InstrumentationToolCallCompletedEvent>;
    readonly "tool.call.failed"?: InstrumentationEventHandler<InstrumentationToolCallFailedEvent>;
    readonly "turn.cancelled"?: InstrumentationEventHandler<InstrumentationTurnTerminalEvent>;
    readonly "turn.completed"?: InstrumentationEventHandler<InstrumentationTurnTerminalEvent>;
    readonly "turn.failed"?: InstrumentationEventHandler<InstrumentationTurnTerminalEvent>;
    readonly "turn.started"?: InstrumentationEventHandler<InstrumentationTurnStartedEvent>;
  };
}

/** Events that carry an operation `id`, pairing a start with its terminal. */
export type InstrumentationCorrelatedEvent =
  | InstrumentationModelCallStartedEvent
  | InstrumentationModelCallTerminalEvent
  | InstrumentationToolCallStartedEvent
  | InstrumentationToolCallTerminalEvent;

export type InstrumentationPointEvent =
  | InstrumentationAttemptStartedEvent
  | InstrumentationAttemptMetadataEvent
  | InstrumentationAttemptTerminalEvent
  | InstrumentationSessionStartedEvent
  | InstrumentationSessionTransitionEvent
  | InstrumentationTurnStartedEvent
  | InstrumentationTurnTerminalEvent;

export type InstrumentationEvent = InstrumentationCorrelatedEvent | InstrumentationPointEvent;

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
  publish(event: InstrumentationEvent): Promise<void>;
}

const log = createLogger("harness.instrumentation-lifecycle");

/** Creates failure-isolated hooks backed by an ordered provider list. */
export function createInstrumentationHooks(
  providers: readonly InstrumentationProviderDefinition[],
): InstrumentationHooks {
  const publish = async (event: InstrumentationEvent): Promise<void> => {
    for (const provider of providers) {
      const handler = provider.events?.[event.type];
      if (handler === undefined) continue;
      try {
        await (handler as InstrumentationEventHandler<InstrumentationEvent>)(event);
      } catch (error) {
        log.warn("instrumentation provider failed", {
          boundary: event.type,
          error: formatError(error),
        });
      }
    }
  };

  return { publish };
}
