import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  type DurableCompiledArtifactsSource,
  resolveDurableCompiledArtifactsSource,
} from "#runtime/durable-compiled-artifacts-source.js";
import { createDurableSessionState, type DurableSessionState } from "#execution/session/state.js";
import { createSession } from "#execution/session.js";
import { resolveInheritedTokenLimit } from "#execution/run-session-limits.js";
import type { RunSessionLimits } from "#channel/types.js";
import type { JsonObject } from "#shared/json.js";
import { resolveEffectiveAgentRuntimeFromConfig } from "#execution/effective-agent-config.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import { TASK_UPDATE_SESSION_INSTRUCTION } from "#tools/framework/task-update.js";

export interface CreateSessionStateResult {
  readonly state: DurableSessionState;
}

/** Creates domain state inside the first turn's execution step. */
export async function createSessionState(input: {
  readonly compiledArtifactsSource: DurableCompiledArtifactsSource;
  readonly continuationToken: string;
  readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
  readonly inheritedLimits?: RunSessionLimits;
  readonly outputSchema?: JsonObject;
  readonly nodeId?: string;
  readonly rootSessionId?: string;
  readonly sessionId: string;
  readonly taskId?: string;
}): Promise<CreateSessionStateResult> {
  const bundle = await getCompiledRuntimeAgentBundle({
    compiledArtifactsSource: resolveDurableCompiledArtifactsSource(input.compiledArtifactsSource),
    nodeId: input.nodeId,
  });
  const effectiveAgent = resolveEffectiveAgentRuntimeFromConfig(
    bundle,
    input.dynamicSubagentAgentConfig,
  );
  const taskUpdatesEnabled =
    input.taskId !== undefined &&
    effectiveAgent.turnAgent.tools.some(
      (tool) =>
        tool.kind === "authored-tool" &&
        tool.behavior?.handling?.kind === "dispatch" &&
        tool.behavior.handling.target.kind === "task-update",
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
      maxTokenCostUsdPerSession: resolveInheritedTokenLimit({
        configured: effectiveAgent.limits?.maxTokenCostUsdPerSession,
        inherited: input.inheritedLimits?.maxTokenCostUsdPerSession,
      }),
    },
    outputSchema: input.outputSchema,
    rootSessionId: input.rootSessionId,
    sessionId: input.sessionId,
    systemPromptAdditions: taskUpdatesEnabled ? [TASK_UPDATE_SESSION_INSTRUCTION] : undefined,
    taskId: input.taskId,
    turnAgent: effectiveAgent.turnAgent,
    workflowMaxSubagents: bundle.resolvedAgent.workflowTool?.maxSubagents,
  });

  return { state: createDurableSessionState({ session }) };
}
