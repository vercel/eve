import type {
  ActivityObserverConfig,
  ChannelInstrumentationProjection,
  RunSessionLimits,
  SessionAuthContext,
  SessionCapabilities,
  SessionParent,
} from "#channel/types.js";
import type { LocalDevRequestProvenance } from "#context/keys.js";
import type { DynamicSubagentSelections } from "#execution/agent-sessions/target.js";
import type { PreparedCoordinationDispatch } from "#execution/coordination-dispatch-shared.js";
import type { ActivityWorkIdentityV1 } from "#protocol/activity.js";
import {
  serializeDurableCompiledArtifactsSource,
  type DurableCompiledArtifactsSource,
} from "#runtime/durable-compiled-artifacts-source.js";
import type { SandboxState } from "#sandbox/state.js";
import type { ConversationContext } from "#shared/conversation-context.js";
import { resolveRemainingSessionTokenLimits } from "#subagents/token-budget.js";
import {
  resolveToolCallAgentTrace,
  type AgentChildTraceDispatch,
} from "#tracing/agent-invocation-coordinator.js";

/**
 * What a workflow run needs to open `ctx.agent` sessions for its caller,
 * captured from the calling session in the run's start input. The run never
 * reads the session again: opening, sending to, and ending its sessions never
 * pass through the caller.
 */
export interface AgentSessionContext {
  readonly activityObserver?: ActivityObserverConfig & {
    readonly workIdentity: ActivityWorkIdentityV1;
  };
  /** The caller's principal, which every session runs as. */
  readonly auth: SessionAuthContext | null;
  readonly bundle: AgentSessionBundle;
  /** Forwarded unchanged, so a session asks a person only when its caller can. */
  readonly capabilities?: SessionCapabilities;
  readonly channelMetadata?: ChannelInstrumentationProjection;
  readonly conversation?: ConversationContext;
  /** Dynamic agents the calling turn selected, by node id. */
  readonly dynamicSelections: DynamicSubagentSelections;
  readonly initiatorAuth: SessionAuthContext | null;
  /** The token budget each session inherits: the caller's remaining quota. */
  readonly limits: RunSessionLimits;
  readonly localDevRequest?: LocalDevRequestProvenance;
  /** The calling session, turn, and tool call, recorded as each session's lineage. */
  readonly parent: SessionParent;
  readonly sandbox: AgentSessionSandbox;
  readonly trace: AgentChildTraceDispatch;
}

/** The compiled agent that owns the tool, which resolves agent names. */
export interface AgentSessionBundle {
  readonly nodeId?: string;
  readonly source: DurableCompiledArtifactsSource;
}

/** The caller's sandbox, which agents declared with a parent sandbox share. */
export interface AgentSessionSandbox {
  readonly sessionId: string;
  readonly state?: SandboxState;
}

type CallerDispatch = Pick<
  PreparedCoordinationDispatch<unknown>,
  | "activityObserver"
  | "auth"
  | "batch"
  | "bundle"
  | "capabilities"
  | "channelMetadata"
  | "dynamicSubagentSelections"
  | "inheritedConversation"
  | "initiatorAuth"
  | "localDevRequest"
  | "sandboxSessionId"
  | "serializedContext"
  | "session"
>;

/** Captures the agent session context for one workflow tool call's run. */
export function captureAgentSessionContext(
  caller: CallerDispatch,
  callId: string,
): AgentSessionContext {
  const { batch, session } = caller;
  return {
    activityObserver: caller.activityObserver,
    auth: caller.auth,
    bundle: {
      nodeId: caller.bundle.nodeId,
      source: serializeDurableCompiledArtifactsSource(caller.bundle.compiledArtifactsSource),
    },
    capabilities: caller.capabilities,
    channelMetadata: caller.channelMetadata,
    conversation: caller.inheritedConversation,
    dynamicSelections: caller.dynamicSubagentSelections,
    initiatorAuth: caller.initiatorAuth,
    limits: resolveRemainingSessionTokenLimits(session),
    localDevRequest: caller.localDevRequest,
    parent: {
      callId,
      rootSessionId: session.rootSessionId ?? session.sessionId,
      sessionId: session.sessionId,
      turn: { id: batch.event.turnId, sequence: batch.event.sequence },
    },
    sandbox: { sessionId: caller.sandboxSessionId, state: session.sandboxState },
    trace: resolveToolCallAgentTrace({
      callId,
      conversation: caller.inheritedConversation,
      serializedContext: caller.serializedContext,
      sessionId: session.sessionId,
      turnId: batch.event.turnId,
    }),
  };
}
