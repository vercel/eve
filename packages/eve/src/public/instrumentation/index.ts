import type { ExactDefinition } from "#public/definitions/exact.js";

/**
 * Instrumentation authoring helpers for `agent/instrumentation.ts`.
 */

import type { ModelMessage, SystemModelMessage } from "ai";

import type { SessionAuthContext, SessionParent } from "#channel/types.js";
import type { InstrumentationChannel } from "#public/channels/index.js";
import type { JsonObject } from "#shared/json.js";

// Re-export channel metadata types so existing `eve/instrumentation`
// imports continue to work. The canonical home is `eve/channels`.
export {
  isChannel,
  type ChannelMetadataMap,
  type ChannelReferenceMap,
  type InstrumentationChannel,
  type InstrumentationChannelForChannel,
  type InstrumentationChannelForKind,
  type InstrumentationChannelKind,
  type InstrumentationChannelMetadata,
} from "#public/channels/index.js";

/**
 * Context passed to the {@link InstrumentationDefinition.setup} callback.
 */
export interface InstrumentationSetupContext {
  /**
   * The agent name declared by `defineAgent`. Use as the `serviceName` for
   * `registerOTel` instead of a hard-coded string.
   */
  readonly agentName: string;
}

/**
 * User-authored runtime context values attached to AI SDK telemetry spans.
 *
 * Keys beginning with `eve.` are reserved for framework-owned context
 * and are ignored when returned from authored instrumentation.
 */
export type InstrumentationRuntimeContext = JsonObject;

/**
 * Session lineage and auth snapshot exposed to instrumentation callbacks.
 *
 * `auth.current` is the caller principal for this turn (null when the
 * request carried no credentials). `auth.initiator` is the principal that
 * started the root session, falling back to `auth.current` for root
 * sessions. `parent` is present only for delegated subagent sessions.
 */
export interface InstrumentationSession {
  readonly auth: {
    readonly current: SessionAuthContext | null;
    readonly initiator: SessionAuthContext | null;
  };
  readonly id: string;
  readonly parent?: SessionParent;
}

/**
 * Identifies the turn in progress when an instrumentation event fires.
 * `id` is the turn identifier; `sequence` is its zero-based position
 * within the session.
 */
export interface InstrumentationTurn {
  readonly id: string;
  readonly sequence: number;
}

/**
 * The step (model-call attempt) in progress for an instrumentation event.
 * `index` is the zero-based step index within the current turn.
 */
export interface InstrumentationStep {
  readonly index: number;
}

/**
 * Final model input assembled for one model-call attempt, snapshotted for
 * instrumentation. `instructions` is the resolved system prompt (a single
 * string, an array of system messages, or undefined when there is none).
 * `messages` is the non-system conversation passed to the model.
 */
export interface InstrumentationModelInput {
  readonly instructions: string | readonly SystemModelMessage[] | undefined;
  readonly messages: readonly ModelMessage[];
}

/**
 * Input passed to `events["step.started"]`. eve runs the callback after
 * building the final model input for this attempt and before constructing
 * the AI SDK model call.
 */
export interface InstrumentationStepStartedEventInput {
  readonly channel: InstrumentationChannel;
  readonly modelInput: InstrumentationModelInput;
  readonly session: InstrumentationSession;
  readonly step: InstrumentationStep;
  readonly turn: InstrumentationTurn;
}

/**
 * Result of a `step.started` callback. eve merges `runtimeContext` into the
 * AI SDK telemetry span; child spans inherit the values. Keys beginning with
 * `eve.` and non-JSON-serializable values are dropped. Return `undefined` to
 * contribute no context.
 */
export interface InstrumentationStepStartedEventResult {
  /**
   * Additional runtime context merged into AI SDK telemetry spans.
   */
  readonly runtimeContext: InstrumentationRuntimeContext;
}

/**
 * Event hooks accepted by {@link defineInstrumentation}.
 */
export interface InstrumentationEvents {
  /**
   * Resolve per-attempt runtime context before the model call. The AI SDK
   * child spans inherit the returned values.
   */
  readonly "step.started"?: (
    input: InstrumentationStepStartedEventInput,
  ) => InstrumentationStepStartedEventResult | undefined;
}

/**
 * Authored instrumentation settings accepted by `defineInstrumentation`.
 *
 * The presence of a `defineInstrumentation` export implicitly enables
 * telemetry. There is no separate `isEnabled` toggle.
 */
export interface InstrumentationDefinition {
  /**
   * Override the function identifier attached to telemetry spans
   * (`ai.telemetry.functionId`). Defaults to the agent name; omitted when
   * neither is set.
   */
  readonly functionId?: string;
  /**
   * Instrumentation event hooks.
   */
  readonly events?: InstrumentationEvents;
  /**
   * Whether to record full model inputs in telemetry spans. Defaults to
   * `true` when `instrumentation.ts` is present. Set `false` for sensitive
   * inputs or to reduce span payload size.
   */
  readonly recordInputs?: boolean;
  /**
   * Whether to record full model outputs in telemetry spans. Defaults to
   * `true` when `instrumentation.ts` is present.
   */
  readonly recordOutputs?: boolean;
  /**
   * Setup callback invoked at server startup with the resolved agent name.
   * Use it to call `registerOTel` or other OTel provider setup;
   * `context.agentName` comes from `defineAgent`.
   */
  readonly setup?: (context: InstrumentationSetupContext) => void;
}

/**
 * Export the result as the default export of `agent/instrumentation.ts`. eve
 * reads these settings at server startup and applies them to every AI SDK
 * model call. The `setup` callback runs later with the resolved agent name,
 * not during `defineInstrumentation` itself.
 */
export function defineInstrumentation<T extends InstrumentationDefinition>(
  definition: ExactDefinition<T, InstrumentationDefinition>,
): T {
  return definition;
}
