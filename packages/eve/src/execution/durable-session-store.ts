import type { HarnessModelMessage } from "#harness/messages.js";
import { readHitlState } from "#harness/hitl/index.js";
import type {
  CompactionState,
  HarnessSession,
  HarnessSessionBase,
  SessionStateMap,
} from "#harness/types.js";
import { projectToDurableSession } from "#execution/session.js";
import type { SandboxState } from "#sandbox/state.js";
import type { JsonObject } from "#shared/json.js";

import { DURABLE_SESSION_VERSION } from "#execution/durable-session-read.js";

export { DURABLE_SESSION_VERSION, readDurableSession } from "#execution/durable-session-read.js";

export interface DurableSessionState {
  readonly version: typeof DURABLE_SESSION_VERSION;
  readonly sessionId: string;
  readonly continuationToken: string;
  readonly hasProxyInputRequests: boolean;
  readonly snapshot: DurableSessionSnapshot;
}

export interface DurableSession {
  readonly sessionId: string;
  readonly rootSessionId?: string;
  readonly continuationToken: string;
  readonly outputSchema?: JsonObject;
  readonly state?: SessionStateMap;
  readonly sandboxState?: SandboxState;
  readonly compaction?: CompactionState;
}

export interface DurableSessionSnapshot {
  readonly session: DurableSession;
}

export function createDurableSessionState(input: {
  readonly session: HarnessSessionBase;
}): DurableSessionState {
  return projectDurableSessionState(projectToDurableSession(input.session));
}

export function createDurableSessionValues(session: HarnessSession): {
  readonly history: HarnessModelMessage[];
  readonly sessionState: DurableSessionState;
} {
  return { history: session.history, sessionState: createDurableSessionState({ session }) };
}

export function replaceDurableSessionSnapshot(input: {
  readonly session: DurableSession;
  readonly state: DurableSessionState;
}): DurableSessionState {
  return { ...input.state, ...projectDurableSessionState(input.session) };
}

function projectDurableSessionState(session: DurableSession): DurableSessionState {
  return {
    continuationToken: session.continuationToken,
    hasProxyInputRequests: readHitlState(session.state).relays.size > 0,
    sessionId: session.sessionId,
    version: DURABLE_SESSION_VERSION,
    snapshot: { session },
  };
}
