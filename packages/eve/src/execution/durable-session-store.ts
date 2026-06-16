/**
 * Durable session storage.
 *
 * Session-mutating steps return the current snapshot inside
 * {@link DurableSessionState}; Workflow step results are the atomic
 * persistence boundary for session program memory. The legacy
 * `"eve.session"` stream remains as a fallback for old in-flight
 * sessions that only carry a small state handle.
 *
 * The driver workflow run is pinned to the deployment that called
 * `start()`; child turn workflows run on latest. Both
 * {@link DurableSessionState} and {@link DurableSessionSnapshot} carry
 * a `version` so a pinned driver can ferry shapes written by newer
 * steps. Adding optional fields is forward-compatible (devalue
 * preserves unknown POJO fields); shape-breaking changes bump
 * `version` and add a migrator.
 */
import type { ModelMessage } from "ai";

import { getHarnessEmissionState, type HarnessEmissionState } from "#harness/emission.js";
import { hasProxyInputRequests } from "#harness/proxy-input-requests.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import { migrateDurableSessionSnapshot } from "#execution/durable-session-migrations/snapshot.js";
import { projectToDurableSession } from "#execution/session.js";
import type { SandboxState } from "#sandbox/state.js";
import type { JsonObject } from "#shared/json.js";

const EVE_SESSION_STREAM_NAMESPACE = "eve.session";

/** Current wire version for {@link DurableSessionState} and {@link DurableSessionSnapshot}. */
export const DURABLE_SESSION_VERSION = 1;

const DURABLE_SESSION_READ_TIMEOUT_MS = 10_000;

/**
 * Serializable handle to a durable session.
 *
 * Carries the current session snapshot plus the small projections the
 * workflow body needs without taking a step boundary: identity, the
 * hook continuation token,
 * `hasProxyInputRequests` (a closed-contract short-circuit that lets
 * the driver skip a per-delivery proxy-routing step when no
 * descendant subagent is active), and `emissionState` (so workflow-body
 * framework steps can stamp protocol events
 * with `{ turnId, sequence, stepIndex }` without reading the full
 * durable session). All other control-plane state travels via
 * {@link import("#execution/next-driver-action.js").NextDriverAction}.
 * `snapshot` is optional so old stream-backed states can still read
 * from the legacy `eve.session` fallback.
 */
export interface DurableSessionState {
  readonly version: typeof DURABLE_SESSION_VERSION;
  readonly sessionId: string;
  readonly continuationToken: string;
  readonly hasProxyInputRequests: boolean;
  readonly emissionState: HarnessEmissionState;
  readonly snapshot?: DurableSessionSnapshot;
}

/**
 * Durable projection of {@link HarnessSession} embedded in state
 * snapshots or legacy `eve.session` stream chunks.
 *
 * Omits `agent.modelReference`, `agent.tools`,
 * `agent.compactionModelReference`, and the `compaction` thresholds —
 * those are rebuilt every turn from `bundle.turnAgent` by
 * {@link import("#execution/session.js").hydrateDurableSession}.
 * `agent.system` is the session-start prompt snapshot, pinned at
 * `createSession`.
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
  readonly history: ModelMessage[];
  readonly outputSchema?: JsonObject;
  readonly state?: SessionStateMap;
  readonly sandboxState?: SandboxState;
  readonly agent: {
    readonly system: string;
  };
  readonly compaction?: {
    readonly lastKnownInputTokens?: number;
    readonly lastKnownPromptMessageCount?: number;
  };
}

/** Versioned wrapper around a {@link DurableSession} on the wire. */
export interface DurableSessionSnapshot {
  readonly version: typeof DURABLE_SESSION_VERSION;
  readonly session: DurableSession;
}

/** Projects a {@link HarnessSession} into the boundary-safe state value. */
export function projectSessionState(input: {
  readonly session: HarnessSession;
}): DurableSessionState {
  return {
    continuationToken: input.session.continuationToken,
    emissionState: getHarnessEmissionState(input.session.state),
    hasProxyInputRequests: hasProxyInputRequests(input.session.state),
    sessionId: input.session.sessionId,
    version: DURABLE_SESSION_VERSION,
  };
}

/**
 * Reads the latest durable session snapshot and returns the
 * {@link DurableSession} inside.
 *
 * New states carry the snapshot directly through Workflow step
 * results. States without `snapshot` fall back to the legacy
 * `eve.session` stream tail (`startIndex: -1`). The snapshot is
 * migrated to {@link DURABLE_SESSION_VERSION} before return; unknown
 * versions throw.
 *
 * Devalue handles encode/decode so rich types in the session (URL
 * `FilePart.data`, Buffer, Date, Map, Set) round-trip structurally.
 *
 * MUST be called from inside a `"use step"` body.
 */
export async function readDurableSession(state: DurableSessionState): Promise<DurableSession> {
  if (state.snapshot !== undefined) {
    return migrateDurableSessionSnapshot(state.snapshot).session;
  }

  // Dynamic import: the workflow runtime is only available inside a
  // `"use step"` body, and a static import would pull it into the
  // workflow-body bundle.
  const { getRun } = await import("#compiled/@workflow/core/runtime.js");
  const stream = getRun<unknown>(state.sessionId).getReadable<unknown>({
    namespace: EVE_SESSION_STREAM_NAMESPACE,
    startIndex: -1,
  });
  const reader = stream.getReader();
  let cancelReason = "eve durable session tail read failed";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read().then((read) => ({ kind: "read" as const, read })),
      new Promise<{ readonly kind: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timeout" }), DURABLE_SESSION_READ_TIMEOUT_MS);
      }),
    ]);

    if (result.kind === "timeout") {
      cancelReason = `eve durable session tail read timed out after ${DURABLE_SESSION_READ_TIMEOUT_MS}ms`;
      throw new DurableSessionReadTimeoutError(state);
    }

    if (result.read.done || result.read.value === undefined) {
      cancelReason = "eve durable session tail read returned no snapshot";
      throw new Error(
        `No durable session snapshot found in stream "${EVE_SESSION_STREAM_NAMESPACE}" for run ${state.sessionId}.`,
      );
    }

    cancelReason = "eve durable session tail read complete";
    const snapshot = migrateDurableSessionSnapshot(result.read.value);
    return snapshot.session;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    await reader.cancel(cancelReason).catch(() => {});
    reader.releaseLock();
  }
}

class DurableSessionReadTimeoutError extends Error {
  constructor(state: DurableSessionState) {
    super(
      `Timed out reading durable session snapshot from stream "${EVE_SESSION_STREAM_NAMESPACE}" for run ${state.sessionId} after ${DURABLE_SESSION_READ_TIMEOUT_MS}ms.`,
    );
    this.name = "DurableSessionReadTimeoutError";
  }
}

/**
 * Creates the projected {@link DurableSessionState} with the current
 * snapshot embedded in the Workflow step result.
 */
export function createDurableSessionState(input: {
  readonly session: HarnessSession;
}): DurableSessionState {
  const snapshot: DurableSessionSnapshot = {
    session: projectToDurableSession(input.session),
    version: DURABLE_SESSION_VERSION,
  };

  return {
    ...projectSessionState({ session: input.session }),
    snapshot,
  };
}
