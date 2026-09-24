import type { DispatchOutcome, RuntimeSession } from "#subagents/start-outcome.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import type { LocalDevRequestProvenance } from "#context/keys.js";
import { buildSubagentRunInput, type SubagentInputSource } from "#subagents/tool.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { START_FAILED } from "#subagents/agent-handle-errors.js";
import { createLogger, logError } from "#internal/logging.js";
import type { RuntimeSubagentDispatchRequest } from "#shared/action-types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { toErrorMessage } from "#shared/errors.js";
import type { SubagentParentContext } from "#subagents/invocation.js";

const log = createLogger("execution.subagent-start-local");

type DynamicSubagentAgentConfig = Parameters<
  typeof createWorkflowRuntime
>[0]["dynamicSubagentAgentConfig"];

/**
 * Starts one local subagent after dispatch planning has selected its target.
 * It does not wait for the child: the child claims its continuation address
 * (so a duplicate start exits) and then reports to its owner.
 */
export async function startLocalSubagent(input: {
  readonly action: RuntimeSubagentDispatchRequest;
  readonly auth: Parameters<typeof buildSubagentRunInput>[0]["auth"];
  readonly bundle: CompiledBundle;
  readonly capabilities: Parameters<typeof buildSubagentRunInput>[0]["capabilities"];
  readonly channelMetadata: Parameters<typeof buildSubagentRunInput>[0]["channelMetadata"];
  readonly inheritedConversation?: Parameters<
    typeof buildSubagentRunInput
  >[0]["inheritedConversation"];
  readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
  readonly fanoutSize: number;
  readonly initiatorAuth: Parameters<typeof buildSubagentRunInput>[0]["initiatorAuth"];
  readonly localDevRequest?: LocalDevRequestProvenance;
  readonly parent: SubagentParentContext;
  readonly activityObserver?: Parameters<typeof buildSubagentRunInput>[0]["activityObserver"];
  readonly sandboxSessionId: string;
  readonly session: RuntimeSession;
  readonly source: SubagentInputSource;
  readonly taskId: string;
}): Promise<DispatchOutcome> {
  const { action, source } = input;
  const childRuntime = createWorkflowRuntime({
    compiledArtifactsSource: input.bundle.compiledArtifactsSource,
    dynamicSubagentAgentConfig: input.dynamicSubagentAgentConfig,
    nodeId: action.nodeId,
  });
  const { runInput } = buildSubagentRunInput({
    action,
    auth: input.auth,
    capabilities: input.capabilities,
    channelMetadata: input.channelMetadata,
    inheritedConversation: input.inheritedConversation,
    fanoutSize: input.fanoutSize,
    initiatorAuth: input.initiatorAuth,
    graph: input.bundle.graph,
    parent: input.parent,
    activityObserver: input.activityObserver,
    sandboxSessionId: input.sandboxSessionId,
    session: input.session,
    selfAgent: source.type === "runtime",
    source,
    taskId: input.taskId,
  });

  try {
    await contextStorage.run(new ContextContainer({ localDevRequest: input.localDevRequest }), () =>
      childRuntime.createSession(runInput),
    );
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
          code: START_FAILED,
          message: toErrorMessage(error),
        },
        subagentName: action.subagentName,
      },
    };
  }
  return { kind: "started" };
}
