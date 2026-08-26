import type { DispatchOutcome, RuntimeSession } from "#execution/agent-handle-dispatch.js";
import { deriveChildActivityObserverConfig } from "#execution/activity-work.js";
import { mintStartOperation } from "#execution/dispatch-start-operation.js";
import { isRuntimeSessionOwnershipConflictError } from "#execution/runtime-errors.js";
import { buildSubagentRunInput, type SubagentInputSource } from "#execution/subagent-tool.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { SUBAGENT_START_FAILED } from "#harness/agent-handle-errors.js";
import {
  confirmAgentStarted,
  confirmTaskAgentAddress,
  prepareAgentStart,
  rejectAgentEffect,
} from "#harness/handles/transitions.js";
import { createLogger, logError } from "#internal/logging.js";
import type { RuntimeSubagentCallActionRequest } from "#shared/action-types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { toErrorMessage } from "#shared/errors.js";

const log = createLogger("execution.subagent-start-local");

type DynamicSubagentAgentConfig = Parameters<
  typeof createWorkflowRuntime
>[0]["dynamicSubagentAgentConfig"];

/** Starts one local subagent after dispatch planning has selected its target. */
export async function startLocalSubagent(input: {
  readonly action: RuntimeSubagentCallActionRequest;
  readonly auth: Parameters<typeof buildSubagentRunInput>[0]["auth"];
  readonly batchEvent: { readonly sequence: number; readonly turnId: string };
  readonly bundle: CompiledBundle;
  readonly capabilities: Parameters<typeof buildSubagentRunInput>[0]["capabilities"];
  readonly channelMetadata: Parameters<typeof buildSubagentRunInput>[0]["channelMetadata"];
  readonly currentSession: RuntimeSession;
  readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
  readonly fanoutSize: number;
  readonly initiatorAuth: Parameters<typeof buildSubagentRunInput>[0]["initiatorAuth"];
  readonly parentContinuationToken: string | undefined;
  readonly parentTraceContext: Parameters<typeof buildSubagentRunInput>[0]["parentTraceContext"];
  readonly activityObserver?: Parameters<typeof buildSubagentRunInput>[0]["activityObserver"];
  readonly sandboxSessionId: string;
  readonly session: RuntimeSession;
  readonly source: SubagentInputSource;
  readonly taskOwned: boolean;
}): Promise<DispatchOutcome> {
  const { action, source } = input;
  const activityObserver = deriveChildActivityObserverConfig({
    activityObserver: input.activityObserver,
    callId: action.callId,
    kind: "subagent",
    name: action.subagentName,
    parentSessionId: input.session.sessionId,
    parentTurnId: input.batchEvent.turnId,
  });
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
    parentTraceContext: input.parentTraceContext,
    activityObserver,
    sandboxSessionId: input.sandboxSessionId,
    session: input.session,
    source,
  });

  const targetKind = source.type === "runtime" ? ("agent/self" as const) : ("agent/local" as const);
  const { identity, operation } = mintStartOperation({
    callId: action.callId,
    name: action.subagentName,
    nodeId: action.nodeId,
    parentSessionId: input.session.sessionId,
    parentTurnId: input.batchEvent.turnId,
  });
  // Ownership is recorded before the start side effect, and the prepared
  // (or rejected) store rides every outcome into the step result. The
  // guarantee is intra-step: a crash between the accepted start and the
  // step-result commit still replays the whole dispatch step, so the
  // orphan window shrinks to that boundary rather than disappearing.
  const preparedSession = prepareAgentStart(input.currentSession, {
    identity,
    operation,
    target: { continuationToken: childContinuationToken, kind: targetKind },
  });

  let childSessionId: string;
  try {
    const handle = await childRuntime.createSession(runInput);
    childSessionId = handle.sessionId;
  } catch (error) {
    if (!isRuntimeSessionOwnershipConflictError(error)) {
      logError(log, "local subagent start failed", error, {
        callId: action.callId,
        nodeId: action.nodeId,
        subagentName: action.subagentName,
      });
      return {
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
        session: rejectAgentEffect(preparedSession, {
          disposition: "dead",
          operationId: operation.id,
        }),
      };
    }
    // A replayed step re-derives the same deterministic child continuation
    // token, so the run holding it is the child this operation already
    // started. Adopt it instead of failing live work and starting a second
    // child on the next attempt.
    childSessionId = error.ownerSessionId;
  }

  const address = {
    continuationToken: childContinuationToken,
    kind: targetKind,
    sessionId: childSessionId,
  } as const;
  return {
    address,
    callId: action.callId,
    kind: "called",
    name: action.name,
    session: input.taskOwned
      ? confirmTaskAgentAddress(preparedSession, { address, operationId: operation.id })
      : confirmAgentStarted(preparedSession, { address, operationId: operation.id }),
    toolName: action.subagentName,
  };
}
