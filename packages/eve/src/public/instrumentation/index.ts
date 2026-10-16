/**
 * Instrumentation authoring helpers for `agent/instrumentation/`.
 */

import type { SessionAuthContext, SessionParent } from "#channel/types.js";
import type { InstrumentationChannel } from "#public/channels/index.js";
import type { JsonObject } from "#shared/json.js";

export * from "#public/instrumentation/provider.js";

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

/** The model run and its zero-based retry attempt. */
export interface InstrumentationRun {
  readonly id: string;
  readonly attempt: number;
}

/**
 * Input passed to a provider's `runtimeContext` resolver. eve builds it after
 * assembling the final model input for this attempt and before constructing
 * the AI SDK model call.
 */
export interface InstrumentationModelStartedInput {
  readonly channel: InstrumentationChannel;
  readonly modelInput: import("#instrumentation/lifecycle.js").InstrumentationModelInput;
  readonly session: InstrumentationSession;
  readonly run: InstrumentationRun;
  readonly turn?: InstrumentationTurn;
}
