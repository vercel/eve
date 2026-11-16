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

/** What a runtime serves sessions of: an agent's compiled artifacts, and the node it runs. */
export interface SessionRuntimeConfig {
  readonly agentSessionRuntimeOverrides?: AgentSessionRuntimeOverrides;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
  readonly nodeId?: string;
}

/** What a session's first owner starts from, before a host decides where it runs. */
export interface PreparedInitialEntry {
  /** The run input, with its delivery identified. */
  readonly input: RunInput;
  readonly agent: SessionAgent;
  /** The first owner's entry input, without the deployment that owns it. */
  readonly entry: Omit<InitialWorkflowEntryInput, "ownerDeploymentId">;
  readonly serializedContext: Record<string, unknown>;
}

/**
 * Prepares a new session's first owner, whichever host runs it: identifies its delivery, loads
 * its agent, and serializes the context its steps run in.
 */
export async function prepareInitialEntry(
  config: SessionRuntimeConfig,
  input: RunInput,
  /** Set only on a successor of a retired session that has just ended. */
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
  // A losing candidate forwards this command to the winner instead of starting, so it is the
  // same delivery and must carry the same identity.
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
  // Only a compiled graph names tools ahead of a run.
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
  // Workflow cannot purge inputs and outputs independently.
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
