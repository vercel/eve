/**
 * The provider contract authored under `agent/instrumentation/`.
 *
 * Reachable only with `experimental.instrumentationProviders` on. With the flag
 * off nothing discovers that directory, so these types compile but never run.
 */

// Type-only, so nothing couples the provider definition to the harness at
// runtime. The event shapes are eve's own vocabulary; deriving the handler map
// from the union below is what keeps the public contract from drifting away
// from the bus that feeds it.
import type { InstrumentationEvent } from "#instrumentation/lifecycle.js";
import type { JsonValue } from "#shared/json.js";
import type { InstrumentationCapture, TraceCapturePolicy } from "#shared/trace-policy.js";

export type { JsonValue } from "#shared/json.js";

export type {
  InstrumentationActionCompletedEvent,
  InstrumentationActionFailedEvent,
  InstrumentationActionKind,
  InstrumentationActionOutcome,
  InstrumentationActionOutput,
  InstrumentationActionStartedEvent,
  InstrumentationAttemptScope,
  InstrumentationChannelDeliveryInput,
  InstrumentationChannelDeliveryOutcome,
  InstrumentationChannelDeliveryRef,
  InstrumentationChannelDeliveryStartedEvent,
  InstrumentationChannelDeliveryTerminalEvent,
  InstrumentationContentPart,
  InstrumentationEvent,
  InstrumentationInputKind,
  InstrumentationInputOption,
  InstrumentationInputOutcome,
  InstrumentationInputRequest,
  InstrumentationInputRequestedEvent,
  InstrumentationInputResolvedEvent,
  InstrumentationInputResponse,
  InstrumentationModelCallCompletedEvent,
  InstrumentationModelCallFailedEvent,
  InstrumentationModelCallStartedEvent,
  InstrumentationModelRef,
  InstrumentationOperationRef,
  InstrumentationParentLineage,
  InstrumentationSessionFailedEvent,
  InstrumentationSessionSettledEvent,
  InstrumentationSessionStartedEvent,
  InstrumentationSessionTransitionEvent,
  InstrumentationStepAttemptMetadataEvent,
  InstrumentationStepAttemptCompletedEvent,
  InstrumentationStepAttemptFailedEvent,
  InstrumentationStepAttemptStartedEvent,
  InstrumentationStepAttemptTerminalEvent,
  InstrumentationToolCallCompletedEvent,
  InstrumentationToolCallFailedEvent,
  InstrumentationToolCallStartedEvent,
  InstrumentationToolOutput,
  InstrumentationTraceContext,
  InstrumentationTurnFailedEvent,
  InstrumentationTurnSettledEvent,
  InstrumentationTurnStartedEvent,
  InstrumentationTurnTerminalEvent,
  InstrumentationUsage,
} from "#instrumentation/lifecycle.js";
export type {
  InstrumentationCapture,
  TraceCaptureContext,
  TraceCapturePolicy,
  TracePolicyDecision,
} from "#shared/trace-policy.js";

/**
 * Marks a value as having come from `defineInstrumentation` or a built-in
 * factory.
 *
 * It does not say which layout the value belongs to: a provider and a legacy
 * config both carry `events` and `setup`, so no value-level check separates
 * them. The layout decides — `agent/instrumentation.ts` is read as a config and
 * `agent/instrumentation/*.ts` as providers, and the two are mutually exclusive
 * builds. The brand's job is only to catch a default export that never went
 * through eve at all.
 */
export const PROVIDER = Symbol.for("eve.instrumentation.provider");

/** Marks a slot the author turned off rather than configured. */
export const DISABLED = Symbol.for("eve.instrumentation.disabled");

/** Where the agent is running when `setup` fires. */
export type InstrumentationEnvironment = "development" | "preview" | "production";

/** The local eval run this server was started to serve. */
export interface EvaluationRef {
  readonly runId: string;
}

/**
 * Passed to {@link InstrumentationProvider.setup} once at server startup,
 * before any event is published.
 */
export interface ProviderSetupContext {
  /** The agent name declared by `defineAgent`. */
  readonly agentName: string;
  /** Always supplied at runtime; optional for legacy setup-context compatibility. */
  readonly environment?: InstrumentationEnvironment;
  /** Present only when this server was started for a local `eve eval` run. */
  readonly evaluation?: EvaluationRef;
  /** The eve version running the agent. */
  /** Always supplied at runtime; optional for legacy setup-context compatibility. */
  readonly frameworkVersion?: string;
}

export interface ProviderState {
  get(): JsonValue | undefined;
  /** Stages a JSON value; `undefined` releases this operation's slot. */
  set(value: JsonValue | undefined): void;
}

export interface ProviderContext {
  readonly state: ProviderState;
}

/**
 * One event handler.
 *
 * A handler can carry durable JSON state from a start to its terminal through
 * `ctx.state`. eve scopes and releases that state by provider and operation.
 */
export type Handler<TEvent> = (event: TEvent, ctx: ProviderContext) => void | PromiseLike<void>;

type EventForType<TEvent, TType> = TEvent extends { readonly type: infer TEventType }
  ? TType extends TEventType
    ? TEvent & { readonly type: TType }
    : never
  : never;

/**
 * The events a provider may handle, one optional handler per event type.
 *
 * Derived from the event union rather than written out, so a new event reaches
 * providers the moment the bus can publish it.
 */
export type ProviderEvents = {
  readonly [TType in InstrumentationEvent["type"]]?: Handler<
    EventForType<InstrumentationEvent, TType>
  >;
};

/**
 * What an author writes for one file under `agent/instrumentation/`.
 *
 * Setup runs in slot order, but event handlers across authored providers run
 * concurrently and are failure-isolated. Do not coordinate providers through
 * completion order.
 */
export interface ProviderDefinition {
  /** @deprecated Use `tracePolicy`. Ignored when `tracePolicy` is also set. */
  readonly capture?: InstrumentationCapture;
  /**
   * Whether this provider receives events and which content directions they
   * include. Defaults to emitting every audience, with content only for public
   * conversations. Boolean `true` uses the same audience-aware content rule;
   * an explicit emitted decision can authorize either direction independently.
   * A thrown error disables this provider for the trace. The policy can run
   * again across durable steps, so it must be deterministic.
   */
  readonly tracePolicy?: TraceCapturePolicy;
  readonly events?: ProviderEvents;
  /** Runs once at server startup, before any event is published. */
  readonly setup?: (context: ProviderSetupContext) => void | PromiseLike<void>;
  /** Drains anything buffered. eve calls this before a session goes idle. */
  readonly flush?: () => void | PromiseLike<void>;
  /** Releases resources when the process is going away. */
  readonly shutdown?: () => void | PromiseLike<void>;
}

/** A {@link ProviderDefinition} that has been through `defineInstrumentation`. */
export type InstrumentationProvider = ProviderDefinition & {
  readonly [PROVIDER]: true;
};

/** A slot the author turned off. eve registers nothing for it. */
export interface InstrumentationDisabled {
  readonly [DISABLED]: true;
}

/**
 * Turns off the slot the file it is exported from names.
 *
 * Export it as the default of `agent/instrumentation/local.ts` to stop eve
 * spooling local traces, for instance. Omitting the file entirely leaves eve's
 * default in place, which is why turning one off takes a value.
 */
export function disableInstrumentation(): InstrumentationDisabled {
  return { [DISABLED]: true };
}

export function isInstrumentationProvider(value: unknown): value is InstrumentationProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<InstrumentationProvider>)[PROVIDER] === true
  );
}

export function isInstrumentationDisabled(value: unknown): value is InstrumentationDisabled {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<InstrumentationDisabled>)[DISABLED] === true
  );
}
