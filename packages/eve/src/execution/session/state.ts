import type { ModelMessage } from "ai";

import { getHarnessEmissionState, type HarnessEmissionState } from "#harness/emission.js";
import { hasProxyInputRequests } from "#harness/proxy-input-requests.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import { projectToDurableSession } from "#execution/session.js";
import type { SandboxState } from "#sandbox/state.js";
import type { JsonObject } from "#shared/json.js";

/** In-memory domain state. Persist it in a checkpoint, never in workflow history. */
export interface DurableSessionState {
  readonly sessionId: string;
  readonly continuationToken: string;
  readonly hasProxyInputRequests: boolean;
  readonly emissionState: HarnessEmissionState;
  readonly snapshot: DurableSessionSnapshot;
}

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

export interface DurableSessionSnapshot {
  readonly session: DurableSession;
}

export function readDurableSession(state: DurableSessionState): DurableSession {
  return state.snapshot.session;
}

export function createDurableSessionState(input: {
  readonly session: HarnessSession;
}): DurableSessionState {
  return replaceDurableSessionSnapshot({ session: projectToDurableSession(input.session) });
}

export function replaceDurableSessionSnapshot(input: {
  readonly session: DurableSession;
}): DurableSessionState {
  return {
    continuationToken: input.session.continuationToken,
    emissionState: getHarnessEmissionState(input.session.state),
    hasProxyInputRequests: hasProxyInputRequests(input.session.state),
    sessionId: input.session.sessionId,
    snapshot: { session: input.session },
  };
}
