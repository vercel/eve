/**
 * Leaf context keys — no codec, no runtime imports. Safe to import from any
 * tier. Codec-carrying keys (`ChannelKey`, `BundleKey`) live in
 * `#runtime/sessions/runtime-context-keys.ts`.
 */

import type { SystemModelMessage } from "ai";

import type { JsonObject } from "#shared/json.js";
import type {
  ChannelInstrumentationProjection,
  SessionAuthContext,
  SessionCallback,
  SessionCapabilities,
  SessionParent,
  SessionTurn,
} from "#channel/types.js";
import { ContextKey } from "#context/key.js";
import type { SandboxAccess } from "#sandbox/state.js";
import type { RunMode } from "#shared/run-mode.js";

// Re-export so consumers don't need a direct channel/ import.
export type { SessionAuthContext, SessionParent, SessionTurn } from "#channel/types.js";

// ---------------------------------------------------------------------------
// Session types (public API surface)
// ---------------------------------------------------------------------------

/**
 * Auth metadata on the active session.
 *
 * `current` is the caller of the most recent request.
 * `initiator` is the caller who originally created the session.
 */
export interface SessionAuth {
  readonly current: SessionAuthContext | null;
  readonly initiator: SessionAuthContext | null;
}

/**
 * Internal session metadata seeded into the context container under
 * {@link SessionKey}.
 *
 * This is not the shape authored code observes. Tools, hooks, and channel
 * events receive the `SessionContext.session` projection (via `ctx.session`),
 * whose session id is exposed as `id`, not `sessionId`.
 */
export interface Session {
  readonly auth: SessionAuth;
  readonly parent?: SessionParent;
  readonly sessionId: string;
  readonly turn: SessionTurn;
}

// ---------------------------------------------------------------------------
// Seed keys — serializable values carried across workflow step boundaries.
// ---------------------------------------------------------------------------

export const AuthKey = new ContextKey<SessionAuthContext | null>("eve.auth");
export const InitiatorAuthKey = new ContextKey<SessionAuthContext | null>("eve.initiatorAuth");
export const SessionIdKey = new ContextKey<string>("eve.sessionId");
export const ContinuationTokenKey = new ContextKey<string>("eve.continuationToken");
export const ChannelRequestIdKey = new ContextKey<string>("eve.channelRequestId");
export const ChannelInstrumentationKey = new ContextKey<ChannelInstrumentationProjection>(
  "eve.channelInstrumentation",
);
export const ModeKey = new ContextKey<RunMode>("eve.mode");
export const ParentSessionKey = new ContextKey<SessionParent>("eve.parentSession");
export const SubagentDepthKey = new ContextKey<number>("eve.subagentDepth");
export const SubagentMaxDepthKey = new ContextKey<number>("eve.subagentMaxDepth");

/**
 * Session-level capability flags (see {@link SessionCapabilities}). Set
 * on root runs by channel routes and inherited pointwise by subagent
 * dispatch so HITL readiness flows through a conversation chain.
 */
export const CapabilitiesKey = new ContextKey<SessionCapabilities>("eve.capabilities");

/**
 * Optional framework-owned terminal callback metadata for this session.
 */
export const SessionCallbackKey = new ContextKey<SessionCallback>("eve.sessionCallback");

// ---------------------------------------------------------------------------
// Derived keys — reconstructed by providers each step, never serialized.
// ---------------------------------------------------------------------------

export const SessionKey = new ContextKey<Session>("eve.session");
export const SandboxKey = new ContextKey<SandboxAccess>("eve.sandbox");

// ---------------------------------------------------------------------------
// Dynamic tool keys
// ---------------------------------------------------------------------------

export interface DurableDynamicToolMetadata {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly resolverSlug: string;
  readonly entryKey: string;
  readonly executeStepFnName?: string;
  readonly approvalStepFnName?: string;
  readonly closureVars?: Record<string, unknown>;
}

/**
 * Session-scoped dynamic tool metadata (from `session.started`).
 * Persists for the session lifetime.
 */
export const SessionDynamicToolMetadataKey = new ContextKey<readonly DurableDynamicToolMetadata[]>(
  "eve.sessionDynamicToolMetadata",
);

/**
 * Turn-scoped dynamic tool metadata (from `turn.started`).
 * Replaced each turn.
 */
export const TurnDynamicToolMetadataKey = new ContextKey<readonly DurableDynamicToolMetadata[]>(
  "eve.turnDynamicToolMetadata",
);

/**
 * Virtual (non-serialized) live step-scoped tool definitions from
 * `step.started` resolvers. Carries original execute closures so
 * framework tools (which lack bundler step-function metadata) work.
 * Re-resolved every step — no cross-step persistence needed.
 */
export const LiveStepToolsKey = new ContextKey<
  import("#harness/execute-tool.js").HarnessToolDefinition[]
>("eve.liveStepTools");

// ---------------------------------------------------------------------------
// Dynamic skill keys
// ---------------------------------------------------------------------------

/**
 * Durable metadata for one session-scoped dynamic skill.
 */
export interface DurableDynamicSkillMetadata {
  readonly name: string;
  readonly description: string;
}

/**
 * Durable map from resolver slug to the qualified skills it last produced.
 * Used to diff on re-resolution, clean up removed skills from the sandbox,
 * and rebuild the model-visible announcement across turns.
 */
export const DynamicSkillManifestKey = new ContextKey<
  Record<string, readonly DurableDynamicSkillMetadata[]>
>("eve.dynamicSkillManifest");

// ---------------------------------------------------------------------------
// Dynamic instruction keys
// ---------------------------------------------------------------------------

/**
 * Durable session-scoped instruction messages (from `session.started`
 * resolvers). Keyed by resolver slug. Persists for the session lifetime.
 */
export const SessionDynamicInstructionsKey = new ContextKey<
  Record<string, readonly SystemModelMessage[]>
>("eve.sessionDynamicInstructions");

/**
 * Durable turn-scoped instruction messages (from `turn.started`
 * resolvers). Keyed by resolver slug. Replaced each turn.
 */
export const TurnDynamicInstructionsKey = new ContextKey<
  Record<string, readonly SystemModelMessage[]>
>("eve.turnDynamicInstructions");
