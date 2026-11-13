import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  type DurableCompiledArtifactsSource,
  resolveDurableCompiledArtifactsSource,
} from "#runtime/durable-compiled-artifacts-source.js";
import {
  createDurableSessionValues,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { createSession } from "#execution/session.js";
import type { JsonObject } from "#shared/json.js";
import type { AgentSessionRuntimeOverrides } from "#execution/agent-sessions/runtime-overrides.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import { withPendingHistory } from "#execution/session/pending-history.js";
import type { SessionHistoryMessage } from "#shared/session-history.js";

/**
 * Result returned by {@link createSessionStep}.
 *
 * Exposes the projected {@link DurableSessionState} and the history the
 * owner needs to drive the turn loop.
 */
export interface CreateSessionStepResult {
  readonly history: HarnessModelMessage[];
  readonly state: DurableSessionState;
}

/**
 * Creates the durable session and returns the initial snapshot-bearing
 * state before the workflow enters its turn loop.
 * `nodeId` targets a subagent node in the compiled graph; omitted for
 * the root agent.
 */
export async function createSessionStep(input: {
  readonly agentSessionRuntimeOverrides?: AgentSessionRuntimeOverrides;
  /** Absent for a held agent, which has no compiled graph to check. */
  readonly compiledArtifactsSource?: DurableCompiledArtifactsSource;
  readonly continuationToken: string;
  readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
  /** History from `create()`, held until the first message's turn adds it. */
  readonly history?: readonly SessionHistoryMessage[];
  readonly outputSchema?: JsonObject;
  readonly nodeId?: string;
  readonly rootSessionId?: string;
  readonly sessionId: string;
}): Promise<CreateSessionStepResult> {
  "use step";

  if (input.compiledArtifactsSource !== undefined) {
    const bundle = await getCompiledRuntimeAgentBundle({
      compiledArtifactsSource: resolveDurableCompiledArtifactsSource(input.compiledArtifactsSource),
      nodeId: input.nodeId,
    });
    if (
      bundle.turnAgent.configResolver === true &&
      input.dynamicSubagentAgentConfig === undefined
    ) {
      throw new Error("Dynamic subagent execution requires a selected concrete agent config.");
    }
  }

  const session = createSession({
    continuationToken: input.continuationToken,
    outputSchema: input.outputSchema,
    rootSessionId: input.rootSessionId,
    sessionId: input.sessionId,
  });

  const state = withPendingHistory(session.state, input.history);
  const { history, sessionState } = createDurableSessionValues(
    state === session.state ? session : { ...session, state },
  );
  return { history, state: sessionState };
}
