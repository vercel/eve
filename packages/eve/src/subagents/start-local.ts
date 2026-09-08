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
import { SUBAGENT_EXECUTION_SCHEMA } from "#tools/framework/agent-contract.js";
import { resolveRuntimeModelSelection } from "#runtime/agent/resolve-model.js";

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
  readonly parentTraceContext: Parameters<typeof buildSubagentRunInput>[0]["parentTraceContext"];
  readonly activityObserver?: Parameters<typeof buildSubagentRunInput>[0]["activityObserver"];
  readonly sandboxSessionId: string;
  readonly session: RuntimeSession;
  readonly source: SubagentInputSource;
  readonly taskId?: string;
}): Promise<DispatchOutcome> {
  const { action, source } = input;
  const targetKind = source.type === "runtime" ? ("agent/self" as const) : ("agent/local" as const);
  try {
    let agentConfig = input.dynamicSubagentAgentConfig;
    if (action.input.execution !== undefined) {
      const execution = SUBAGENT_EXECUTION_SCHEMA.parse(action.input.execution);
      const base = input.bundle.graph.nodesByNodeId.get(action.nodeId)?.agent.config;
      if (base === undefined || !base.delegationModels?.includes(execution.model)) {
        throw new Error("Delegation execution settings are not authorized for this child.");
      }
      const selected = await resolveRuntimeModelSelection({
        durability: "durable",
        selection: { model: execution.model },
        state: new ContextContainer(),
      });
      agentConfig = {
        description: base.description ?? action.description,
        model: selected.reference,
        reasoning: execution.reasoning ?? base.reasoning,
        limits: base.limits,
        outputSchema: base.outputSchema,
        compaction: base.compaction,
      };
    }
    const childRuntime = createWorkflowRuntime({
      compiledArtifactsSource: input.bundle.compiledArtifactsSource,
      dynamicSubagentAgentConfig: agentConfig,
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
      activityObserver: input.activityObserver,
      sandboxSessionId: input.sandboxSessionId,
      session: input.session,
      selfAgent: source.type === "runtime",
      source,
      taskId: input.taskId,
    });

    await contextStorage.run(new ContextContainer({ localDevRequest: input.localDevRequest }), () =>
      childRuntime.createSession(runInput),
    );
    const childSessionId = (await waitForCommandHookOwner(childContinuationToken)).runId;
    return {
      address: {
        continuationToken: childContinuationToken,
        kind: targetKind,
        sessionId: childSessionId,
      },
      callId: action.callId,
      kind: "called",
      name: action.name,
      session: input.currentSession,
      toolName: action.subagentName,
    };
  } catch (error) {
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
      session: input.currentSession,
    };
  }
}
