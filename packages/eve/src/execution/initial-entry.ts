import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { validateDeliveryIdempotencyKey } from "#channel/delivery-idempotency.js";
import type { RunInput } from "#channel/types.js";
import { SessionPredecessorKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import type { AgentSessionRuntimeOverrides } from "#execution/agent-sessions/runtime-overrides.js";
import { agentLimits } from "#execution/effective-agent-config.js";
import { buildRunContext } from "#execution/runtime-context.js";
import type { InitialWorkflowEntryInput } from "#execution/session/entry-input.js";
import { initializeSessionInstrumentation } from "#instrumentation/runtime.js";
import type { SessionPredecessor } from "#protocol/session-events/families/session.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledSessionAgent } from "#runtime/sessions/compiled-session-agent.js";
import type { SessionAgent } from "#runtime/sessions/session-agent.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import { validateToolStubTargets } from "#tool-stubs/validate-targets.js";

export interface SessionRuntimeConfig {
  readonly agentSessionRuntimeOverrides?: AgentSessionRuntimeOverrides;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
  readonly nodeId?: string;
}

export interface PreparedInitialEntry {
  readonly input: RunInput;
  readonly agent: SessionAgent;
  readonly entry: Omit<InitialWorkflowEntryInput, "ownerDeploymentId">;
  readonly serializedContext: Record<string, unknown>;
}

export async function prepareInitialEntry(
  config: SessionRuntimeConfig,
  input: RunInput,
  predecessor?: SessionPredecessor,
): Promise<PreparedInitialEntry> {
  validateDeliveryIdempotencyKey(input.idempotencyKey);
  if (input.input.message !== undefined && input.delivery === undefined) {
    input = {
      ...input,
      delivery: createChannelDeliveryMetadata({
        channelKind: input.adapter.kind,
        channelName: input.channelName ?? input.adapter.kind,
        requestId: input.requestId,
      }),
    };
  }
  const conflictCommand = input.continuationConflictCommand;
  if (conflictCommand !== undefined && conflictCommand.delivery === undefined) {
    input = {
      ...input,
      continuationConflictCommand: { ...conflictCommand, delivery: input.delivery },
    };
  }
  const agent = await loadCompiledSessionAgent({
    compiledArtifactsSource: config.compiledArtifactsSource,
    nodeId: config.nodeId,
  });
  const graph = agent.compiled?.graph;
  if (
    graph !== undefined &&
    input.toolStubs !== undefined &&
    input.toolStubs.rootSessionId === undefined
  ) {
    validateToolStubTargets(input.toolStubs.rules, graph);
  }
  const ctx = buildRunContext({
    agent,
    agentSessionRuntimeOverrides: config.agentSessionRuntimeOverrides,
    dynamicSubagentAgentConfig: config.dynamicSubagentAgentConfig,
    run: input,
  });
  if (predecessor !== undefined) ctx.set(SessionPredecessorKey, predecessor);
  const traceDecision = initializeSessionInstrumentation({
    agentName: agent.id,
    ctx,
  });
  const sessionTimeoutMs = agentLimits(agent, ctx)?.sessionTimeoutMs;
  const retention =
    agent.settings.retention ??
    (traceDecision.action === "record" && traceDecision.recordInputs && traceDecision.recordOutputs
      ? undefined
      : 0);
  const serializedContext = serializeContext(ctx);
  const entry: {
    -readonly [K in keyof PreparedInitialEntry["entry"]]: PreparedInitialEntry["entry"][K];
  } = {
    idempotencyKey: input.idempotencyKey,
    kind: "initial",
    input: input.input,
    serializedContext,
  };
  if (input.continuationConflictCommand !== undefined) {
    entry.continuationConflictCommand = input.continuationConflictCommand;
  }
  if (sessionTimeoutMs !== undefined) entry.sessionTimeoutMs = sessionTimeoutMs;
  if (retention !== undefined) entry.retention = retention;
  return { agent, entry, input, serializedContext };
}
