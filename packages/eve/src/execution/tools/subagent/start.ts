import type { ActivityObserverConfig } from "#channel/types.js";
import { ConversationIdKey, type LocalDevRequestProvenance } from "#context/keys.js";
import type { ActivityWorkIdentityV1 } from "#protocol/activity.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import type { DynamicRemoteAgentConfig } from "#runtime/subagents/dynamic-remote-agent-config.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type {
  RuntimeRemoteAgentDispatchRequest,
  RuntimeSubagentDispatchRequest,
} from "#shared/action-types.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import {
  applyLiveDeliveryAudienceCeiling,
  readForwardedTraceAssertion,
} from "#shared/forwarded-trace-policy.js";
import type { DispatchOutcome, RuntimeSession } from "#subagents/handle-dispatch.js";
import { startLocalSubagent } from "#subagents/start-local.js";
import { startRemoteSubagent } from "#subagents/start-remote.js";
import { buildSubagentRunInput, type SubagentInputSource } from "#subagents/tool.js";
import {
  readActionTraceContext,
  readSessionTraceContext,
} from "#tracing/agent-trace-context-store.js";
import type { SubagentParentContext } from "#subagents/invocation.js";
import { readConversationId } from "#tracing/conversation-context.js";

export type SubagentStartTarget =
  | {
      readonly kind: "local";
      readonly action: RuntimeSubagentDispatchRequest;
      readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
      readonly source: SubagentInputSource;
    }
  | {
      readonly kind: "remote";
      readonly action: RuntimeRemoteAgentDispatchRequest;
      readonly dynamicRemoteAgent?: DynamicRemoteAgentConfig;
    };

/** Starts one planned fresh child against its local or remote target. */
export async function startSubagent(input: {
  readonly auth: Parameters<typeof buildSubagentRunInput>[0]["auth"];
  readonly batchEvent: { readonly sequence: number; readonly turnId: string };
  readonly bundle: CompiledBundle;
  readonly callbackBaseUrl: string | undefined;
  readonly capabilities: Parameters<typeof buildSubagentRunInput>[0]["capabilities"];
  readonly channelMetadata: Parameters<typeof buildSubagentRunInput>[0]["channelMetadata"];
  readonly currentSession: RuntimeSession;
  readonly fanoutSize: number;
  readonly instrumentationCallId?: string;
  readonly initiatorAuth: Parameters<typeof buildSubagentRunInput>[0]["initiatorAuth"];
  readonly localDevRequest?: LocalDevRequestProvenance;
  readonly parentContinuationToken: string | undefined;
  readonly activityObserver?: ActivityObserverConfig & {
    readonly workIdentity: ActivityWorkIdentityV1;
  };
  readonly sandboxSessionId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly session: RuntimeSession;
  readonly taskId?: string;
  readonly target: SubagentStartTarget;
}): Promise<DispatchOutcome> {
  const actionCallId = input.instrumentationCallId;
  const storedParentTraceContext =
    (actionCallId === undefined
      ? undefined
      : readActionTraceContext(
          input.serializedContext,
          input.session.sessionId,
          input.batchEvent.turnId,
          actionCallId,
        )) ??
    readActionTraceContext(
      input.serializedContext,
      input.session.sessionId,
      input.batchEvent.turnId,
      input.target.action.callId,
    ) ??
    readSessionTraceContext(input.serializedContext, input.session.sessionId);
  const forwardedTracePolicy = readForwardedTraceAssertion(
    storedParentTraceContext?.forwardedTracePolicy,
  );
  const liveAudience = normalizeChannelAudience(input.channelMetadata?.metadata.audience);
  const parentTraceContext =
    storedParentTraceContext?.decision === undefined
      ? storedParentTraceContext
      : {
          ...storedParentTraceContext,
          decision: applyLiveDeliveryAudienceCeiling(
            storedParentTraceContext.decision,
            liveAudience,
            forwardedTracePolicy,
          ),
        };
  const parent: SubagentParentContext = {
    conversationId:
      readConversationId(input.serializedContext[ConversationIdKey.name]) ??
      input.session.rootSessionId ??
      input.session.sessionId,
    lineage: {
      callId: input.target.action.callId,
      rootSessionId: input.session.rootSessionId ?? input.session.sessionId,
      sessionId: input.session.sessionId,
      turn: { id: input.batchEvent.turnId, sequence: input.batchEvent.sequence },
    },
    continuationToken: input.parentContinuationToken,
    traceContext: parentTraceContext,
  };

  switch (input.target.kind) {
    case "local":
      return startLocalSubagent({
        action: input.target.action,
        auth: input.auth,
        bundle: input.bundle,
        capabilities: input.capabilities,
        channelMetadata: input.channelMetadata,
        currentSession: input.currentSession,
        dynamicSubagentAgentConfig: input.target.dynamicSubagentAgentConfig,
        fanoutSize: input.fanoutSize,
        initiatorAuth: input.initiatorAuth,
        localDevRequest: input.localDevRequest,
        parent,
        activityObserver: input.activityObserver,
        sandboxSessionId: input.sandboxSessionId,
        session: input.session,
        source: input.target.source,
        taskId: input.taskId,
      });
    case "remote":
      return startRemoteSubagent({
        action: input.target.action,
        auth: input.auth,
        bundle: input.bundle,
        callbackBaseUrl: input.callbackBaseUrl,
        originAudience: forwardedTracePolicy?.originAudience ?? liveAudience,
        currentSession: input.currentSession,
        dynamicRemoteAgent: input.target.dynamicRemoteAgent,
        initiatorAuth: input.initiatorAuth,
        parent,
        activityObserver: input.activityObserver,
        session: input.session,
        taskId: input.taskId,
      });
    default: {
      const _exhaustive: never = input.target;
      return _exhaustive;
    }
  }
}
