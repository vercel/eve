import { hasDelegatedSessionContext } from "#execution/delegated-session-context.js";
import type {
  ChannelInstrumentationProjection,
  SessionCapabilities,
  SessionParent,
  SessionTraceRoot,
} from "#channel/types.js";
import { ContinuationTokenKey, type LocalDevRequestProvenance } from "#context/keys.js";
import { STUB_CONTEXT_KEY, type StubScope } from "#tool-stubs/types.js";
import { readSerializedSessionSchedule, type SessionSchedule } from "#context/session-schedule.js";
import type { DynamicSubagentSelections } from "#execution/agent-sessions/target.js";
import type { PreparedCoordinationDispatch } from "#execution/coordination-dispatch-shared.js";
import { agentSessionOwner, type AgentSessionOwner } from "#execution/agent-sessions/owner.js";
import type { SandboxState } from "#sandbox/state.js";
import type { ConversationContext } from "#shared/conversation-context.js";
import type { WorkflowAgentMetadata } from "#tools/workflow-definition.js";
import {
  resolveToolCallAgentTrace,
  type AgentChildTraceDispatch,
} from "#tracing/eve/agent-invocation-coordinator.js";

/**
 * What a workflow run needs to open `ctx.agent` sessions for its caller,
 * captured from the calling session for one call: the run's start input
 * carries it for the call that started the run, and each later call to a
 * `serve` task carries its own. The run never reads the session again:
 * opening, sending to, and ending its sessions never pass through the caller.
 *
 * It is a session's lineage, bound when the session opens. Auth is not part
 * of it: each message carries the auth of the call that sends it.
 */
export type AgentSessionContext = AgentSessionLineage & AgentSessionOwner;

/** {@link AgentSessionContext}, beside the agent that owns the call. */
export interface AgentSessionLineage {
  readonly toolStubs?: StubScope;
  /** The agents the call may open, by name, which `ctx.agents` lists. */
  readonly agents: Readonly<Record<string, WorkflowAgentMetadata>>;
  /** Forwarded unchanged, so a session asks a person only when its caller can. */
  readonly capabilities?: SessionCapabilities;
  readonly schedule?: SessionSchedule;
  readonly channelMetadata?: ChannelInstrumentationProjection;
  /** The calling session's address on its channel, which `ctx.channel.continuationToken` reads. */
  readonly continuationToken?: string;
  readonly conversation?: ConversationContext;
  /** Dynamic agents the calling turn selected, by node id. */
  readonly dynamicSelections: DynamicSubagentSelections;
  /** Whether a parent, local or remote, delegated the calling session. */
  readonly delegated?: boolean;
  readonly localDevRequest?: LocalDevRequestProvenance;
  /** The calling session, turn, and tool call, recorded as each session's lineage. */
  readonly parent: SessionParent;
  /** Present when the caller's trace root differs from `parent.rootSessionId`. */
  readonly traceRoot?: SessionTraceRoot;
  readonly sandbox: AgentSessionSandbox;
  readonly trace: AgentChildTraceDispatch;
}

/** The caller's sandbox, which agents declared with a parent sandbox share. */
export interface AgentSessionSandbox {
  readonly sessionId: string;
  readonly state?: SandboxState;
}

type CallerDispatch = Pick<
  PreparedCoordinationDispatch<unknown>,
  | "batch"
  | "owner"
  | "capabilities"
  | "channelMetadata"
  | "dynamicSubagentSelections"
  | "inheritedConversation"
  | "localDevRequest"
  | "sandboxSessionId"
  | "sandboxState"
  | "serializedContext"
  | "session"
  | "traceRoot"
  | "workflowAgents"
>;

/** Captures the agent session context for one workflow tool call, in the step that admits it. */
export function captureAgentSessionContext(
  caller: CallerDispatch,
  callId: string,
): AgentSessionContext {
  const { batch, session } = caller;
  return {
    agents: caller.workflowAgents,
    toolStubs: caller.serializedContext[STUB_CONTEXT_KEY] as StubScope | undefined,
    ...agentSessionOwner(caller.owner.reference),
    capabilities: caller.capabilities,
    schedule: readSerializedSessionSchedule(caller.serializedContext),
    channelMetadata: caller.channelMetadata,
    continuationToken: caller.serializedContext[ContinuationTokenKey.name] as string | undefined,
    conversation: caller.inheritedConversation,
    dynamicSelections: caller.dynamicSubagentSelections,
    delegated: hasDelegatedSessionContext(caller.serializedContext),
    localDevRequest: caller.localDevRequest,
    parent: {
      callId,
      rootSessionId: session.rootSessionId ?? session.sessionId,
      sessionId: session.sessionId,
      turn: { id: batch.event.turnId, sequence: batch.event.sequence },
    },
    sandbox: { sessionId: caller.sandboxSessionId, state: caller.sandboxState },
    traceRoot: caller.traceRoot,
    trace: resolveToolCallAgentTrace({
      callId,
      conversation: caller.inheritedConversation,
      serializedContext: caller.serializedContext,
      sessionId: session.sessionId,
      turnId: batch.event.turnId,
    }),
  };
}
