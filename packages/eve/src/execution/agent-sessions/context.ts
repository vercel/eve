import type {
  ActivityObserverConfig,
  ChannelInstrumentationProjection,
  RunSessionLimits,
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
import { findTask, readTaskTable } from "#execution/tasks/table.js";
import type { ConversationContext } from "#shared/conversation-context.js";
import { resolveRemainingSessionTokenLimits } from "#subagents/token-budget.js";
import type { WorkflowAgentMetadata } from "#tools/workflow-definition.js";
import {
  resolveToolCallAgentTrace,
  type AgentChildTraceDispatch,
} from "#tracing/agent-invocation-coordinator.js";

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
export interface AgentSessionContext {
  readonly activityObserver?: ActivityObserverConfig & {
    readonly workIdentity: ActivityWorkIdentityV1;
  };
  /** The agents the call may open, by name, which `ctx.agents` lists. */
  readonly agents: Readonly<Record<string, WorkflowAgentMetadata>>;
  readonly bundle: AgentSessionBundle;
  /** Forwarded unchanged, so a session asks a person only when its caller can. */
  readonly capabilities?: SessionCapabilities;
  readonly channelMetadata?: ChannelInstrumentationProjection;
  readonly conversation?: ConversationContext;
  /** Dynamic agents the calling turn selected, by node id. */
  readonly dynamicSelections: DynamicSubagentSelections;
  /** The token budget each session inherits: its share of the caller's remaining quota. */
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
  | "batch"
  | "bundle"
  | "capabilities"
  | "channelMetadata"
  | "dynamicSubagentSelections"
  | "inheritedConversation"
  | "localDevRequest"
  | "sandboxSessionId"
  | "serializedContext"
  | "session"
  | "workflowAgents"
>;

/**
 * The token budget every session a model step's calls open inherits: the
 * caller's remaining quota split evenly across the agent tasks the step
 * starts, local or remote, so those tasks are bounded by the remainder
 * together. Sessions a workflow tool opens with `ctx.agent` get the same
 * share without dividing it further. A call to a running task starts none,
 * so it takes no share.
 */
export function resolveStepAgentLimits(
  caller: Pick<PreparedCoordinationDispatch, "plan" | "session">,
): RunSessionLimits {
  const table = readTaskTable(caller.session.state);
  const agentTasksStarted = caller.plan.filter(
    ({ entry }) => entry.entryPoint === "serve" && findTask(table, entry.taskId)?.kind === "agent",
  ).length;
  return resolveRemainingSessionTokenLimits(caller.session, agentTasksStarted);
}

/** Captures the agent session context for one workflow tool call, in the step that admits it. */
export function captureAgentSessionContext(
  caller: CallerDispatch,
  callId: string,
  limits: RunSessionLimits,
): AgentSessionContext {
  const { batch, session } = caller;
  return {
    activityObserver: caller.activityObserver,
    agents: caller.workflowAgents,
    bundle: {
      nodeId: caller.bundle.nodeId,
      source: serializeDurableCompiledArtifactsSource(caller.bundle.compiledArtifactsSource),
    },
    capabilities: caller.capabilities,
    channelMetadata: caller.channelMetadata,
    conversation: caller.inheritedConversation,
    dynamicSelections: caller.dynamicSubagentSelections,
    limits,
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
