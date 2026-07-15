import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  type DurableCompiledArtifactsSource,
  resolveDurableCompiledArtifactsSource,
} from "#runtime/durable-compiled-artifacts-source.js";
import {
  createDurableSessionState,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { createSession } from "#execution/session.js";
import { resolveInheritedTokenLimit } from "#execution/run-session-limits.js";
import type { RunSessionLimits } from "#channel/types.js";
import type { JsonObject } from "#shared/json.js";

/**
 * Result returned by {@link createSessionStep}.
 *
 * Exposes the projected {@link DurableSessionState} the driver needs to
 * drive the turn loop.
 */
export interface CreateSessionStepResult {
  readonly state: DurableSessionState;
}

/**
 * Creates the durable session and returns the initial snapshot-bearing
 * state before the workflow enters its turn loop.
 * `nodeId` targets a subagent node in the compiled graph; omitted for
 * the root agent.
 */
export async function createSessionStep(input: {
  readonly compiledArtifactsSource: DurableCompiledArtifactsSource;
  readonly continuationToken: string;
  readonly inheritedLimits?: RunSessionLimits;
  readonly outputSchema?: JsonObject;
  readonly nodeId?: string;
  readonly rootSessionId?: string;
  readonly sessionId: string;
  readonly subagentDepth?: number;
}): Promise<CreateSessionStepResult> {
  "use step";

  const bundle = await getCompiledRuntimeAgentBundle({
    compiledArtifactsSource: resolveDurableCompiledArtifactsSource(input.compiledArtifactsSource),
    nodeId: input.nodeId,
  });

  // Both token axes resolve tighter-wins against the cap inherited from the
  // delegating parent: a child may narrow what its parent granted, never widen
  // it. Root runs have no inherited limits, so their configured values apply.
  const session = createSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    continuationToken: input.continuationToken,
    limits: {
      // Inherited token limits are the parent's remaining quota share at
      // dispatch time; an authored `false` uncaps only when there is nothing
      // to inherit.
      maxInputTokensPerSession: resolveInheritedTokenLimit({
        configured: bundle.resolvedAgent.config.limits?.maxInputTokensPerSession,
        inherited: input.inheritedLimits?.maxInputTokensPerSession,
      }),
      maxOutputTokensPerSession: resolveInheritedTokenLimit({
        configured: bundle.resolvedAgent.config.limits?.maxOutputTokensPerSession,
        inherited: input.inheritedLimits?.maxOutputTokensPerSession,
      }),
    },
    outputSchema: input.outputSchema,
    rootSessionId: input.rootSessionId,
    sessionId: input.sessionId,
    subagentDepth: input.subagentDepth,
    turnAgent: bundle.turnAgent,
    workflowMaxSubagents: bundle.resolvedAgent.workflowTool?.maxSubagents,
  });

  return { state: createDurableSessionState({ session }) };
}
