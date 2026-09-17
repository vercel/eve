import { withWorkflowStepAuthorization } from "#execution/tools/workflow/step-execution.js";
import type {
  WorkflowStepContext,
  WorkflowStepResult,
} from "#execution/tools/workflow/step-context.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { resolveDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import { resolveRemoteAgentForAction } from "#subagents/remote-dispatch.js";
import { discoverA2AAgent, callA2A, a2aResult, type A2AEndpoint } from "#runtime/a2a/client.js";
import type { A2AOperation } from "#runtime/a2a/types.js";
import type { A2AMessage, A2ATask } from "#internal/a2a/protocol.js";
import type { ToolContext } from "#tools/definition.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

export type A2AOperationResult = {
  readonly endpoint: A2AEndpoint;
  readonly response: { task: A2ATask } | { message: A2AMessage };
};
export async function a2aOperationStep(
  operation: A2AOperation,
  context: Omit<WorkflowStepContext, "abortSignal">,
): Promise<WorkflowStepResult> {
  "use step";
  const definition = {
    ...operation.definition,
    source: resolveDurableCompiledArtifactsSource(operation.definition.source),
  };
  return (await withWorkflowStepAuthorization(executeOperation)({
    args: [{ ...operation, definition }, null],
    contextIndexes: [1],
    context: { ...context, abortSignal: new AbortController().signal },
  })) as WorkflowStepResult;
}
// A2A does not require servers to deduplicate SendMessage. A transport error
// must not cause the workflow SDK to dispatch the same message again.
a2aOperationStep.maxRetries = 0;

async function executeOperation(
  operation: A2AOperation,
  ctx: ToolContext,
): Promise<A2AOperationResult> {
  const input = operation.definition;
  const bundle = await getCompiledRuntimeAgentBundle({
    compiledArtifactsSource: resolveDurableCompiledArtifactsSource(input.source),
    nodeId: input.parentNodeId,
  });
  const remote = resolveRemoteAgentForAction({
    registry: bundle.subagentRegistry.subagentsByNodeId,
    nodeId: input.nodeId,
    remoteAgentName: input.name,
    dynamicRemoteAgent: input.dynamicRemoteAgent,
  });
  if (remote.a2a === undefined)
    throw new Error("The A2A subagent definition is no longer available.");
  const endpoint = await discoverA2AAgent({ ...remote.a2a, url: remote.url }, operation.endpoint);
  const response = await callA2A({
    definition: remote.a2a,
    endpoint,
    ctx,
    method: operation.method,
    params: operation.params,
  });
  if (
    operation.method !== "SendMessage" &&
    (!("task" in response) || response.task.id !== operation.params.id)
  )
    throw new Error("A2A response did not match the requested task.");
  return { endpoint, response };
}
export async function a2aResultStep(
  response: A2AOperationResult["response"],
  outputSchema?: JsonObject,
): Promise<JsonValue> {
  "use step";
  return await a2aResult(response, outputSchema);
}
