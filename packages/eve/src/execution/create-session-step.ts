import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  createDurableSessionState,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { createSession } from "#execution/session.js";
import {
  buildSessionAttributes,
  buildSubagentRootAttributes,
  readParentLineage,
  type SessionIdentitySummary,
} from "#execution/eve-workflow-attributes.js";
import { setEveAttributes } from "#runtime/attributes/emit.js";
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
 *
 * Emits the session/subagent-root `$eve.*` tags from inside this step
 * (so the attribute write folds into a step the session already runs)
 * and returns the durable state value the driver consumes.
 */
export async function createSessionStep(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly continuationToken: string;
  /**
   * First user message of the run, used to derive `$eve.title` for
   * top-level sessions. Threaded in so the session/subagent-root tags
   * can be emitted from inside this step (see the tag write below)
   * instead of the workflow body, where each `setEveAttributes` call
   * spends a standalone `__builtin_set_attributes` step.
   */
  readonly inputMessage: unknown;
  readonly outputSchema?: JsonObject;
  readonly nodeId?: string;
  readonly rootSessionId?: string;
  /**
   * Shared serialized context, read for `$eve.trigger` (channel kind)
   * and to detect whether this run is a delegated subagent root.
   */
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
}): Promise<CreateSessionStepResult> {
  "use step";

  const bundle = await getCompiledRuntimeAgentBundle({
    compiledArtifactsSource: input.compiledArtifactsSource,
    nodeId: input.nodeId,
  });

  const session = createSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    continuationToken: input.continuationToken,
    outputSchema: input.outputSchema,
    rootSessionId: input.rootSessionId,
    sessionId: input.sessionId,
    turnAgent: bundle.turnAgent,
  });

  const state = createDurableSessionState({ session });

  const identity: SessionIdentitySummary = {
    nodeId: bundle.nodeId ?? ROOT_RUNTIME_AGENT_NODE_ID,
  };

  // Tag the session/subagent run for observability dashboards from
  // inside this step. Emitting here (rather than the workflow body)
  // folds the attribute write into this already-durable step instead
  // of spending a separate `__builtin_set_attributes` step. Best effort
  // — `setEveAttributes` swallows runtime failures so a broken tag write
  // never breaks the session itself.
  const parentLineage = readParentLineage(input.serializedContext);
  if (parentLineage.sessionId === undefined) {
    await setEveAttributes(
      buildSessionAttributes({
        inputMessage: input.inputMessage,
        serializedContext: input.serializedContext,
      }),
    );
  } else {
    await setEveAttributes(
      buildSubagentRootAttributes({
        identity,
        parentCallId: parentLineage.callId,
        parentSessionId: parentLineage.sessionId,
        parentTurnId: parentLineage.turnId,
        // `rootSessionId` is the denormalized chain root, always set at
        // dispatch (a first-level subagent's root equals its immediate
        // parent). The fallback only satisfies the optional input type
        // for the unreachable malformed-context case.
        rootSessionId: input.rootSessionId ?? parentLineage.sessionId,
        serializedContext: input.serializedContext,
      }),
    );
  }

  return { state };
}
