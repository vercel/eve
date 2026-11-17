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
import {
  serializeDurableCompiledArtifactsSource,
  type DurableCompiledArtifactsSource,
} from "#runtime/durable-compiled-artifacts-source.js";
import type { SandboxState } from "#sandbox/state.js";
import type { ConversationContext } from "#shared/conversation-context.js";
import type { WorkflowAgentMetadata } from "#tools/workflow-definition.js";
import {
  resolveToolCallAgentTrace,
  type AgentChildTraceDispatch,
} from "#tracing/eve/agent-invocation-coordinator.js";

export interface AgentSessionContext {
  readonly toolStubs?: StubScope;
  readonly agents: Readonly<Record<string, WorkflowAgentMetadata>>;
  readonly bundle: AgentSessionBundle;
  readonly capabilities?: SessionCapabilities;
  readonly schedule?: SessionSchedule;
  readonly channelMetadata?: ChannelInstrumentationProjection;
  readonly continuationToken?: string;
  readonly conversation?: ConversationContext;
  readonly dynamicSelections: DynamicSubagentSelections;
  readonly delegated?: boolean;
  readonly localDevRequest?: LocalDevRequestProvenance;
  readonly parent: SessionParent;
  readonly traceRoot?: SessionTraceRoot;
  readonly sandbox: AgentSessionSandbox;
  readonly trace: AgentChildTraceDispatch;
}

export interface AgentSessionBundle {
  readonly nodeId?: string;
  readonly source: DurableCompiledArtifactsSource;
}

export interface AgentSessionSandbox {
  readonly sessionId: string;
  readonly state?: SandboxState;
}

type CallerDispatch = Pick<
  PreparedCoordinationDispatch<unknown>,
  | "batch"
  | "bundle"
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

export function captureAgentSessionContext(
  caller: CallerDispatch,
  callId: string,
): AgentSessionContext {
  const { batch, session } = caller;
  return {
    agents: caller.workflowAgents,
    toolStubs: caller.serializedContext[STUB_CONTEXT_KEY] as StubScope | undefined,
    bundle: {
      nodeId: caller.bundle.nodeId,
      source: serializeDurableCompiledArtifactsSource(caller.bundle.compiledArtifactsSource),
    },
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
