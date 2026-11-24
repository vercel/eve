import type { AgentSessionRuntimeOverrides } from "#execution/agent-sessions/runtime-overrides.js";

import type {
  ChannelDeliveryMetadata,
  ChannelInstrumentationProjection,
  SessionAuthContext,
  SessionCallback,
  SessionCapabilities,
  SessionParent,
  SessionTraceSeed,
  SessionTraceRoot,
  SessionTurn,
} from "#channel/types.js";
import { ContextKey } from "#context/key.js";
import { STUB_CONTEXT_KEY, type StubScope } from "#tool-stubs/types.js";
import {
  SESSION_INBOX_CONTEXT_KEY,
  type SessionInboxAddress,
} from "#execution/session-inbox/address.js";
import {
  EARLIER_REMOTE_CALLER_CONTEXT_KEY_NAME,
  SESSION_CALLBACK_CONTEXT_KEY_NAME,
} from "#context/key-names.js";
import type { HandleEventFn } from "#harness/types.js";
import type { CrossChannelToFn } from "#channel/cross-channel-receive.js";
import type { InstrumentationChannel } from "#shared/instrumentation-channel.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import type { DynamicRemoteAgentConfig } from "#runtime/subagents/dynamic-remote-agent-config.js";
import type { DynamicRemoteBinding } from "#definitions/remote.js";
import type { SandboxAccess, SandboxSessionEndReason } from "#sandbox/state.js";
import type { ReadFileState } from "#execution/tools/file-state.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import type { RuntimeModel } from "#runtime/agent/resolve-model.js";
import type { PreparedRuntimeDelegationTool } from "#runtime/sessions/turn.js";
import type { SessionPredecessor } from "#protocol/session-events/families/session.js";

export type {
  SessionAuthContext,
  SessionParent,
  SessionTraceRoot,
  SessionTurn,
} from "#channel/types.js";
export type { SessionPredecessor } from "#protocol/session-events/families/session.js";

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

export interface Session {
  readonly auth: SessionAuth;
  readonly parent?: SessionParent;
  readonly predecessor?: SessionPredecessor;
  readonly sessionId: string;
  readonly turn: SessionTurn;
}

export const AuthKey = new ContextKey<SessionAuthContext | null>("eve.auth");
export const ToolStubsKey = new ContextKey<StubScope>(STUB_CONTEXT_KEY);
export const InitiatorAuthKey = new ContextKey<SessionAuthContext | null>("eve.initiatorAuth");
export const SessionIdKey = new ContextKey<string>("eve.sessionId");
export const ConversationIdKey = new ContextKey<string>("eve.conversationId");
export const SessionInboxKey = new ContextKey<SessionInboxAddress>(SESSION_INBOX_CONTEXT_KEY);
export const ContinuationTokenKey = new ContextKey<string>("eve.continuationToken");
export const ContinuationHookTokensKey = new ContextKey<readonly string[]>(
  "eve.continuationHookTokens",
);
export const ChannelRequestIdKey = new ContextKey<string>("eve.channelRequestId");
export interface LocalDevRequestProvenance {
  readonly address: string;
  readonly interactiveClient: boolean;
  readonly signature: string;
}
export const LocalDevRequestKey = new ContextKey<LocalDevRequestProvenance>(
  "eve.internal.localDevRequest",
);
export const OccurrenceIdKey = new ContextKey<string>("eve.scheduleOccurrenceId");
export const ScheduleIdKey = new ContextKey<string>("eve.scheduleId");
export const ScheduleInstanceKey = new ContextKey<string>("eve.scheduleInstance");
export const SessionTitleKey = new ContextKey<string>("eve.sessionTitle");
export const ChannelDeliveryKey = new ContextKey<ChannelDeliveryMetadata>("eve.channelDelivery");
export const TurnDeliveryIdsKey = new ContextKey<readonly string[]>("eve.turnDeliveryIds");
export interface HistoryState {
  readonly announcements?: Readonly<Record<string, string>>;
  readonly messages?: Readonly<Record<string, string>>;
}
export const HistoryStateKey = new ContextKey<HistoryState>("eve.historyState");
export interface OfferedCatalogTools {
  readonly connections: boolean;
  readonly searchableSkills: boolean;
  readonly skills: boolean;
  readonly tools: boolean;
}
export const ChannelInstrumentationKey = new ContextKey<ChannelInstrumentationProjection>(
  "eve.channelInstrumentation",
);
export const ParentSessionKey = new ContextKey<SessionParent>("eve.parentSession");
export const SessionPredecessorKey = new ContextKey<SessionPredecessor>("eve.sessionPredecessor");
export const TraceRootKey = new ContextKey<SessionTraceRoot>("eve.traceRoot");
export const ParentTraceContextKey = new ContextKey<SessionTraceSeed>("eve.parentTraceContext");

export type { SessionTraceSeed } from "#channel/types.js";
export const SessionTraceSeedKey = new ContextKey<SessionTraceSeed>("eve.sessionTraceSeed");
export const OtelTraceEnabledKey = new ContextKey<boolean>("eve.otelTraceEnabled");

export const CapabilitiesKey = new ContextKey<SessionCapabilities>("eve.capabilities");

export const SessionCallbackKey = new ContextKey<SessionCallback>(
  SESSION_CALLBACK_CONTEXT_KEY_NAME,
);

export const EarlierRemoteCallerKey = new ContextKey<number>(
  EARLIER_REMOTE_CALLER_CONTEXT_KEY_NAME,
);

export const SessionKey = new ContextKey<Session>("eve.session");
export const SandboxKey = new ContextKey<SandboxAccess>("eve.sandbox");
export const SandboxTerminalCleanupKey = new ContextKey<
  (reason: SandboxSessionEndReason) => Promise<void>
>("eve.internal.sandboxTerminalCleanup");
export const HandleEventKey = new ContextKey<HandleEventFn>("eve.internal.handleEvent");
export const ToolChannelKey = new ContextKey<{
  readonly channel: InstrumentationChannel;
  readonly to: CrossChannelToFn;
}>("eve.internal.toolChannel");

export interface LiveDynamicModelSelection {
  readonly model?: RuntimeModel;
  readonly reference: RuntimeModelReference;
}

export type DurableDynamicSubagentSelection =
  | {
      readonly agentConfig: DynamicSubagentAgentConfig;
      readonly kind: "subagent";
      readonly prepared: PreparedRuntimeDelegationTool;
      readonly remoteAgent?: never;
    }
  | {
      readonly agentConfig?: never;
      readonly kind: "remote";
      readonly prepared: PreparedRuntimeDelegationTool;
      readonly remoteAgent: DynamicRemoteAgentConfig;
      readonly binding?: DynamicRemoteBinding;
    }
  | null;

export const DynamicSubagentAgentConfigKey = new ContextKey<DynamicSubagentAgentConfig>(
  "eve.dynamicSubagentAgentConfig",
);

export const AgentSessionRuntimeOverridesKey = new ContextKey<AgentSessionRuntimeOverrides>(
  "eve.agentSessionRuntimeOverrides",
);

export interface DurableDynamicSkillMetadata {
  readonly name: string;
  readonly deferred?: true;
  readonly description: string;
  readonly markdown: string;
  readonly revision?: string;
}

export const DynamicSkillSandboxKey = new ContextKey<Readonly<Record<string, string>>>(
  "eve.dynamicSkillSandbox",
);

export const ReadFileStateKey = new ContextKey<ReadFileState>("eve.readFile");
