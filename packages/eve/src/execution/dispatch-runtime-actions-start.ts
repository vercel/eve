import type { ActivityObserverConfig } from "#channel/types.js";
import type { LocalDevRequestProvenance } from "#context/keys.js";
import type { DispatchOutcome, RuntimeSession } from "#execution/agent-handle-dispatch.js";
import type { DispatchStartTarget } from "#execution/dispatch-runtime-actions-shared.js";
import { startLocalSubagent } from "#execution/subagent-start-local.js";
import { startRemoteSubagent } from "#execution/subagent-start-remote.js";
import { buildSubagentRunInput } from "#execution/subagent-tool.js";
import type { ActivityWorkIdentityV1 } from "#protocol/activity.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import {
  applyLiveDeliveryAudienceCeiling,
  readForwardedTraceAssertion,
} from "#shared/forwarded-trace-policy.js";
import { readActionTraceContext } from "#tracing/agent-trace-context-store.js";

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
  readonly initiatorAuth: Parameters<typeof buildSubagentRunInput>[0]["initiatorAuth"];
  readonly localDevRequest?: LocalDevRequestProvenance;
  readonly parentContinuationToken: string | undefined;
  readonly parentTraceContext: Parameters<typeof buildSubagentRunInput>[0]["parentTraceContext"];
  readonly activityObserver?: ActivityObserverConfig & {
    readonly workIdentity: ActivityWorkIdentityV1;
  };
  readonly sandboxSessionId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly session: RuntimeSession;
  readonly taskOwned: boolean;
  readonly target: DispatchStartTarget;
}): Promise<DispatchOutcome> {
  const storedParentTraceContext =
    readActionTraceContext(
      input.serializedContext,
      input.session.sessionId,
      input.batchEvent.turnId,
      input.target.action.callId,
    ) ?? input.parentTraceContext;
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

  switch (input.target.kind) {
    case "local":
      return startLocalSubagent({
        action: input.target.action,
        auth: input.auth,
        batchEvent: input.batchEvent,
        bundle: input.bundle,
        capabilities: input.capabilities,
        channelMetadata: input.channelMetadata,
        currentSession: input.currentSession,
        dynamicSubagentAgentConfig: input.target.dynamicSubagentAgentConfig,
        fanoutSize: input.fanoutSize,
        initiatorAuth: input.initiatorAuth,
        localDevRequest: input.localDevRequest,
        parentContinuationToken: input.parentContinuationToken,
        parentTraceContext,
        activityObserver: input.activityObserver,
        sandboxSessionId: input.sandboxSessionId,
        selfAgent: input.target.selfAgent,
        session: input.session,
        source: input.target.source,
        taskOwned: input.taskOwned,
      });
    case "remote":
      return startRemoteSubagent({
        action: input.target.action,
        auth: input.auth,
        batchEvent: input.batchEvent,
        bundle: input.bundle,
        callbackBaseUrl: input.callbackBaseUrl,
        originAudience: forwardedTracePolicy?.originAudience ?? liveAudience,
        currentSession: input.currentSession,
        dynamicRemoteAgent: input.target.dynamicRemoteAgent,
        initiatorAuth: input.initiatorAuth,
        parentContinuationToken: input.parentContinuationToken,
        parentTraceContext,
        activityObserver: input.activityObserver,
        session: input.session,
        taskOwned: input.taskOwned,
      });
    default: {
      const _exhaustive: never = input.target;
      return _exhaustive;
    }
  }
}
