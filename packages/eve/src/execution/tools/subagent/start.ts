import type { ActivityObserverConfig } from "#channel/types.js";
import type { LocalDevRequestProvenance } from "#context/keys.js";
import type { ActivityWorkIdentityV1 } from "#protocol/activity.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import type { DynamicRemoteAgentConfig } from "#runtime/subagents/dynamic-remote-agent-config.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type {
  RuntimeRemoteAgentDispatchRequest,
  RuntimeSubagentDispatchRequest,
} from "#shared/action-types.js";
import type { DispatchOutcome, RuntimeSession } from "#subagents/handle-dispatch.js";
import { startLocalSubagent } from "#subagents/start-local.js";
import { startRemoteSubagent } from "#subagents/start-remote.js";
import { buildSubagentRunInput, type SubagentInputSource } from "#subagents/tool.js";
import type { AgentChildTraceDispatch } from "#tracing/agent-invocation-coordinator.js";

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
  readonly initiatorAuth: Parameters<typeof buildSubagentRunInput>[0]["initiatorAuth"];
  readonly localDevRequest?: LocalDevRequestProvenance;
  readonly parentContinuationToken: string | undefined;
  readonly activityObserver?: ActivityObserverConfig & {
    readonly workIdentity: ActivityWorkIdentityV1;
  };
  readonly sandboxSessionId: string;
  readonly session: RuntimeSession;
  readonly taskId?: string;
  readonly target: SubagentStartTarget;
  readonly traceDispatch: AgentChildTraceDispatch;
}): Promise<DispatchOutcome> {
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
        activityObserver: input.activityObserver,
        sandboxSessionId: input.sandboxSessionId,
        session: input.session,
        source: input.target.source,
        taskId: input.taskId,
        traceDispatch: input.traceDispatch,
      });
    case "remote":
      return startRemoteSubagent({
        action: input.target.action,
        auth: input.auth,
        batchEvent: input.batchEvent,
        bundle: input.bundle,
        callbackBaseUrl: input.callbackBaseUrl,
        currentSession: input.currentSession,
        dynamicRemoteAgent: input.target.dynamicRemoteAgent,
        initiatorAuth: input.initiatorAuth,
        parentContinuationToken: input.parentContinuationToken,
        activityObserver: input.activityObserver,
        session: input.session,
        taskId: input.taskId,
        traceDispatch: input.traceDispatch,
      });
    default: {
      const _exhaustive: never = input.target;
      return _exhaustive;
    }
  }
}
