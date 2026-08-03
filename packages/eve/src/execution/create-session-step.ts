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
import { resolveEffectiveAgentRuntimeFromConfig } from "#execution/effective-agent-config.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";

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
  readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
  readonly inheritedLimits?: RunSessionLimits;
  readonly outputSchema?: JsonObject;
  readonly outputSchemaRequired?: boolean;
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
  const effectiveAgent = resolveEffectiveAgentRuntimeFromConfig(
    bundle,
    input.dynamicSubagentAgentConfig,
  );

  // Both token axes resolve tighter-wins against the cap inherited from the
  // delegating parent: a child may narrow what its parent granted, never widen
  // it. Root runs have no inherited limits, so their configured values apply.
  const session = createSession({
    compactionOverrides: {
      thresholdPercent: effectiveAgent.thresholdPercent,
    },
    continuationToken: input.continuationToken,
    limits: {
      // Inherited token limits are the parent's remaining quota share at
      // dispatch time; an authored `false` uncaps only when there is nothing
      // to inherit.
      maxInputTokensPerSession: resolveInheritedTokenLimit({
        configured: effectiveAgent.limits?.maxInputTokensPerSession,
        inherited: input.inheritedLimits?.maxInputTokensPerSession,
      }),
      maxOutputTokensPerSession: resolveInheritedTokenLimit({
        configured: effectiveAgent.limits?.maxOutputTokensPerSession,
        inherited: input.inheritedLimits?.maxOutputTokensPerSession,
      }),
    },
    outputSchema: input.outputSchema,
    outputSchemaRequired: input.outputSchemaRequired,
    rootSessionId: input.rootSessionId,
    sessionId: input.sessionId,
    subagentDepth: input.subagentDepth,
    turnAgent: effectiveAgent.turnAgent,
    workflowMaxSubagents: bundle.resolvedAgent.workflowTool?.maxSubagents,
  });

  return { state: createDurableSessionState({ session }) };
}
