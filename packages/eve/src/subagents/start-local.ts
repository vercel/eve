import type { DispatchOutcome, RuntimeSession } from "#subagents/handle-dispatch.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import type { LocalDevRequestProvenance } from "#context/keys.js";
import { buildSubagentRunInput, type SubagentInputSource } from "#subagents/tool.js";
import { createWorkflowRuntime, waitForCommandHookOwner } from "#execution/workflow-runtime.js";
import { SUBAGENT_START_FAILED } from "#subagents/agent-handle-errors.js";
import { createLogger, logError } from "#internal/logging.js";
import type { RuntimeSubagentDispatchRequest } from "#shared/action-types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { toErrorMessage } from "#shared/errors.js";
import { readAcceptedTraceCoordinates } from "#channel/session-trace-state.js";

const log = createLogger("execution.subagent-start-local");

type DynamicSubagentAgentConfig = Parameters<
  typeof createWorkflowRuntime
>[0]["dynamicSubagentAgentConfig"];

/** Starts one local subagent after dispatch planning has selected its target. */
export async function startLocalSubagent(input: {
  readonly action: RuntimeSubagentDispatchRequest;
  readonly auth: Parameters<typeof buildSubagentRunInput>[0]["auth"];
  readonly batchEvent: { readonly sequence: number; readonly turnId: string };
  readonly bundle: CompiledBundle;
  readonly capabilities: Parameters<typeof buildSubagentRunInput>[0]["capabilities"];
  readonly channelMetadata: Parameters<typeof buildSubagentRunInput>[0]["channelMetadata"];
  readonly currentSession: RuntimeSession;
  readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
  readonly fanoutSize: number;
  readonly initiatorAuth: Parameters<typeof buildSubagentRunInput>[0]["initiatorAuth"];
  readonly localDevRequest?: LocalDevRequestProvenance;
  readonly parentContinuationToken: string | undefined;
  readonly parentCallId?: string;
  readonly parentTraceContext: Parameters<typeof buildSubagentRunInput>[0]["parentTraceContext"];
  readonly traceSeed: Parameters<typeof buildSubagentRunInput>[0]["traceSeed"];
  readonly activityObserver?: Parameters<typeof buildSubagentRunInput>[0]["activityObserver"];
  readonly sandboxSessionId: string;
  readonly session: RuntimeSession;
  readonly source: SubagentInputSource;
  readonly taskId?: string;
}): Promise<DispatchOutcome> {
  const { action, source } = input;
  const childRuntime = createWorkflowRuntime({
    compiledArtifactsSource: input.bundle.compiledArtifactsSource,
    dynamicSubagentAgentConfig: input.dynamicSubagentAgentConfig,
    nodeId: action.nodeId,
  });
  const { childContinuationToken, runInput } = buildSubagentRunInput({
    action,
    auth: input.auth,
    batchEvent: input.batchEvent,
    capabilities: input.capabilities,
    channelMetadata: input.channelMetadata,
    fanoutSize: input.fanoutSize,
    initiatorAuth: input.initiatorAuth,
    graph: input.bundle.graph,
    parentContinuationToken: input.parentContinuationToken,
    parentCallId: input.parentCallId,
    parentTraceContext: input.parentTraceContext,
    traceSeed: input.traceSeed,
    activityObserver: input.activityObserver,
    sandboxSessionId: input.sandboxSessionId,
    session: input.session,
    selfAgent: source.type === "runtime",
    source,
    taskId: input.taskId,
  });

  const targetKind = source.type === "runtime" ? ("agent/self" as const) : ("agent/local" as const);
  let childSessionId: string;
  let confirmedTraceId: string | undefined;
  try {
    const created = await contextStorage.run(
      new ContextContainer({ localDevRequest: input.localDevRequest }),
      () => childRuntime.createSession(runInput),
    );
    confirmedTraceId = readAcceptedTraceCoordinates(created)?.traceId;
    childSessionId = (await waitForCommandHookOwner(childContinuationToken)).runId;
    if (created.sessionId !== childSessionId) confirmedTraceId = undefined;
  } catch (error) {
    logError(log, "local subagent start failed", error, {
      callId: action.callId,
      nodeId: action.nodeId,
      subagentName: action.subagentName,
    });
    return {
      childTraceId: confirmedTraceId,
      kind: "error",
      result: {
        callId: action.callId,
        isError: true,
        kind: "subagent-result",
        origin: "dispatch",
        output: {
          code: SUBAGENT_START_FAILED,
          message: toErrorMessage(error),
        },
        subagentName: action.subagentName,
      },
      session: input.currentSession,
    };
  }

  const address: {
    continuationToken: string;
    kind: typeof targetKind;
    sessionId: string;
    traceId?: string;
  } = {
    continuationToken: childContinuationToken,
    kind: targetKind,
    sessionId: childSessionId,
  };
  if (confirmedTraceId !== undefined) address.traceId = confirmedTraceId;
  return {
    address,
    callId: action.callId,
    kind: "called",
    name: action.name,
    session: input.currentSession,
    toolName: action.subagentName,
  };
}
