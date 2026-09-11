import { getHarnessEmissionState, type HarnessEmissionState } from "#harness/emission.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { hasProxyInputRequests } from "#harness/proxy-input-requests.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import { projectToDurableSession } from "#execution/session.js";
import type { SandboxState } from "#sandbox/state.js";
import type { JsonObject } from "#shared/json.js";

/** Explicit checkpoint contract shared by deployment handoffs. */
export const DURABLE_SESSION_VERSION = 1;

/**
 * Serializable handle to a durable session.
 *
 * Carries the current session snapshot plus the small projections the
 * workflow body needs without taking a step boundary: identity, the
 * hook continuation token,
 * `hasProxyInputRequests` (a closed-contract short-circuit that lets
 * the owner skip a per-delivery proxy-routing step when no
 * descendant subagent is active), and `emissionState` (so workflow-body
 * framework steps can stamp protocol events
 * with `{ turnId, sequence, stepIndex }` without reading the full
 * durable session). All other control-plane state travels via
 * {@link import("#execution/turn-step.js").TurnOutcome}.
 */
export interface DurableSessionState {
  readonly version: typeof DURABLE_SESSION_VERSION;
  readonly sessionId: string;
  readonly continuationToken: string;
  readonly hasProxyInputRequests: boolean;
  readonly emissionState: HarnessEmissionState;
  readonly snapshot: DurableSessionSnapshot;
}

/**
 * Durable projection of {@link HarnessSession} embedded in state
 * snapshots.
 *
 * Omits `agent.modelReference`, `agent.tools`,
 * `agent.compactionModelReference`, and the `compaction` thresholds —
 * those are rebuilt every turn from `bundle.turnAgent` by
 * {@link import("#execution/session.js").hydrateDurableSession}.
 * `agent.system` is the last applied prompt snapshot. Before each model step,
 * the execution layer replaces it from the current deployment's
 * `bundle.turnAgent`.
 */
export interface DurableSession {
  readonly sessionId: string;
  /**
   * Top user-facing session id in the dispatch chain. Optional because
   * a top-level session is its own root. Persisted so a rehydrated
   * subagent session still knows its root after a workflow step
   * boundary.
   */
  readonly rootSessionId?: string;
  readonly continuationToken: string;
  readonly history: HarnessModelMessage[];
  readonly limits?: HarnessSession["limits"];
  readonly outputSchema?: JsonObject;
  readonly state?: SessionStateMap;
  readonly sandboxState?: SandboxState;
  readonly taskId?: string;
  readonly workflowMaxSubagents?: number;
  readonly agent: {
    readonly system: string;
  };
  readonly compaction?: {
    readonly lastKnownInputTokens?: number;
    readonly lastKnownPromptMessageCount?: number;
  };
}

/** Session program memory persisted atomically with Workflow step results. */
export interface DurableSessionSnapshot {
  readonly session: DurableSession;
}

/** Reads only the embedded checkpoint; no stream or migration fallback exists. */
export function readDurableSession(state: DurableSessionState): DurableSession {
  if (state.version !== DURABLE_SESSION_VERSION || state.snapshot?.session === undefined) {
    throw new Error("Unsupported session checkpoint. Start a new session on this deployment.");
  }
  return state.snapshot.session;
}

/**
 * Creates the projected {@link DurableSessionState} with the current
 * snapshot embedded in the Workflow step result.
 */
export function createDurableSessionState(input: {
  readonly session: HarnessSession;
}): DurableSessionState {
  return projectDurableSessionState(projectToDurableSession(input.session));
}

/** Replaces session program memory and refreshes its workflow projections. */
export function replaceDurableSessionSnapshot(input: {
  readonly session: DurableSession;
  readonly state: DurableSessionState;
}): DurableSessionState {
  return { ...input.state, ...projectDurableSessionState(input.session) };
}

function projectDurableSessionState(session: DurableSession): DurableSessionState {
  return {
    continuationToken: session.continuationToken,
    emissionState: getHarnessEmissionState(session.state),
    hasProxyInputRequests: hasProxyInputRequests(session.state),
    sessionId: session.sessionId,
    version: DURABLE_SESSION_VERSION,
    snapshot: { session },
  };
}
