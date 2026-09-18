/**
 * Instrumentation authoring helpers for `agent/instrumentation/`.
 */

import type { ModelMessage, SystemModelMessage } from "ai";

import type { SessionAuthContext, SessionParent } from "#channel/types.js";
import type { InstrumentationChannel } from "#public/channels/index.js";
import type { JsonObject } from "#shared/json.js";

export * from "#public/instrumentation/provider.js";

// Re-export channel metadata types so existing `eve/instrumentation`
// imports continue to work. The canonical home is `eve/channels`.
export {
  isChannel,
  type InstrumentationChannel,
  type InstrumentationChannelForChannel,
  type InstrumentationChannelForKind,
  type InstrumentationChannelKind,
  type InstrumentationChannelMetadata,
} from "#public/channels/index.js";

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
 * instrumentation. `instructions` is the resolved system prompt (a string,
 * a system message with provider options, or undefined when there is none).
 * `messages` is the non-system conversation passed to the model.
 */
export interface InstrumentationModelInput {
  readonly instructions: string | SystemModelMessage | undefined;
  readonly messages: readonly ModelMessage[];
}

/**
 * Input passed to a provider's `runtimeContext` resolver. eve builds it after
 * assembling the final model input for this attempt and before constructing
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
 * Input passed to a provider's `runtimeContext` resolver. Same shape as
 * {@link InstrumentationStepStartedEventInput}: channel, session, model input,
 * step, and turn coordinates.
 */
export type InstrumentationRuntimeContextInput = InstrumentationStepStartedEventInput;
