import { cancelWorkflowToolRun } from "#execution/tools/workflow/cancel.js";
import type { A2AAgentDefinitionInput } from "#public/definitions/a2a-agent.js";
import type { DynamicRemoteAgentConfig } from "#runtime/subagents/dynamic-remote-agent-config.js";
import { expectObjectRecord } from "#internal/authored-module.js";
import { startWorkflowOnCurrentDeployment } from "#execution/workflow-runtime.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { serializeDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import { a2aControlToken, type A2AWorkflowInput, type A2ACommand } from "#runtime/a2a/types.js";
import { normalizeRequestedOutputSchema } from "#subagents/invocation.js";
import type { startRemoteSubagent } from "#subagents/start-remote.js";

export async function startA2ASubagent(
  input: Parameters<typeof startRemoteSubagent>[0],
): Promise<{ sessionId: string }> {
  const replyToken = input.parent.continuationToken;
  if (!replyToken || !input.callbackBaseUrl)
    throw new Error("A2A subagent requires a parent callback.");
  const remote = input.bundle.subagentRegistry.subagentsByNodeId.get(
    input.action.nodeId,
  )?.definition;
  const request: A2AWorkflowInput = {
    source: serializeDurableCompiledArtifactsSource(input.bundle.compiledArtifactsSource),
    parentNodeId: input.bundle.nodeId,
    nodeId: input.action.nodeId,
    name: input.action.remoteAgentName,
    dynamicRemoteAgent: input.dynamicRemoteAgent,
    callbackBaseUrl: input.callbackBaseUrl,
    invocation: {
      callId: input.action.callId,
      replyToken,
      message: typeof input.action.input.message === "string" ? input.action.input.message : "",
      outputSchema:
        normalizeRequestedOutputSchema(input.action.input.outputSchema) ??
        input.dynamicRemoteAgent?.outputSchema ??
        (remote?.kind === "remote" ? remote.outputSchema : undefined),
      session: {
        id: input.session.sessionId,
        auth: { current: input.auth ?? null, initiator: input.initiatorAuth ?? null },
        turn: input.parent.lineage.turn,
      },
    },
  };
  const run = await startWorkflowOnCurrentDeployment(
    { workflowId: "workflow//eve//a2aAgentWorkflow" },
    [request],
  );
  return { sessionId: run.runId };
}
export async function sendA2ACommand(sessionId: string, command: A2ACommand): Promise<void> {
  if (command.kind === "cancel") {
    await cancelWorkflowToolRun(
      { runId: sessionId, hookToken: a2aControlToken(sessionId) },
      "Parent canceled A2A work.",
    );
    return;
  }
  await resumeHook(a2aControlToken(sessionId), command);
}

export function resolveDynamicA2ADefinition(
  config: DynamicRemoteAgentConfig,
  factory: Function | undefined,
): A2AAgentDefinitionInput {
  if (config.credentialsStepId !== undefined && factory === undefined)
    throw new Error("A2A credential resolver is no longer registered.");
  const values =
    factory === undefined ? {} : expectObjectRecord(factory(), "Invalid A2A credentials.");
  return {
    url: config.url,
    description: config.description,
    allowedInterfaceOrigins: config.allowedInterfaceOrigins,
    auth: values.auth as A2AAgentDefinitionInput["auth"],
    headers: values.headers as A2AAgentDefinitionInput["headers"],
  };
}
