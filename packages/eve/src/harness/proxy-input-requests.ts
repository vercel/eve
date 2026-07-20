import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import type { InputRequest } from "#runtime/input/types.js";
import type { ProxiedSubagentEventMetadata } from "#protocol/message.js";

const PROXY_INPUT_REQUESTS_KEY = "eve.runtime.proxyInputRequests";

/** Durable parent-owned routing and lifecycle identity for one child request. */
export interface ProxyInputRequestEntry {
  readonly childContinuationToken: string;
  readonly event: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly request: InputRequest;
  readonly subagent: ProxiedSubagentEventMetadata;
}

type ProxyInputRequestMap = Readonly<Record<string, ProxyInputRequestEntry>>;

/** Returns the proxy-routing map as a fresh `Map`. */
export function getProxyInputRequests(
  state: SessionStateMap | undefined,
): ReadonlyMap<string, ProxyInputRequestEntry> {
  return new Map(Object.entries(readMap(state)));
}

/** Returns true while the parent owns at least one descendant HITL request. */
export function hasProxyInputRequests(state: SessionStateMap | undefined): boolean {
  return Object.keys(readMap(state)).length > 0;
}

/**
 * Replaces prior entries for `forChildContinuationToken` with the provided
 * batch. A fresh child batch supersedes that child's stale request metadata.
 */
export function upsertProxyInputRequests(input: {
  readonly entries: readonly (readonly [requestId: string, entry: ProxyInputRequestEntry])[];
  readonly forChildContinuationToken: string;
  readonly session: HarnessSession;
}): HarnessSession {
  const next: Record<string, ProxyInputRequestEntry> = {};

  for (const [requestId, entry] of Object.entries(readMap(input.session.state))) {
    if (entry.childContinuationToken !== input.forChildContinuationToken) {
      next[requestId] = entry;
    }
  }

  for (const [requestId, entry] of input.entries) {
    next[requestId] = entry;
  }

  return writeMap(input.session, next);
}

/** Removes one request after its child forwards a durable settlement result. */
export function clearProxyInputRequest(session: HarnessSession, requestId: string): HarnessSession {
  const current = readMap(session.state);
  if (current[requestId] === undefined) {
    return session;
  }

  const next = { ...current };
  delete next[requestId];
  return writeMap(session, next);
}

/** Removes every entry for a completed child. */
export function clearProxyInputRequestsForChild(
  session: HarnessSession,
  childContinuationToken: string,
): HarnessSession {
  const current = readMap(session.state);
  const next: Record<string, ProxyInputRequestEntry> = {};
  let changed = false;

  for (const [requestId, entry] of Object.entries(current)) {
    if (entry.childContinuationToken === childContinuationToken) {
      changed = true;
      continue;
    }
    next[requestId] = entry;
  }

  return changed ? writeMap(session, next) : session;
}

/** Removes every proxy entry after cancellation or parent teardown. */
export function clearAllProxyInputRequests(session: HarnessSession): HarnessSession {
  return hasProxyInputRequests(session.state) ? writeMap(session, {}) : session;
}

/** Projects one child batch into durable parent routing entries. */
export function toProxyInputRequestEntries(
  payload: SubagentInputRequestHookPayload,
  parentEvent: ProxyInputRequestEntry["event"],
): readonly (readonly [requestId: string, entry: ProxyInputRequestEntry])[] {
  const subagent: ProxiedSubagentEventMetadata = {
    childSessionId: payload.childSessionId,
    childTurnId: payload.event.turnId,
    parentCallId: payload.callId,
    subagentName: payload.subagentName,
  };

  return payload.event.requests.map(
    (request) =>
      [
        request.requestId,
        {
          childContinuationToken: payload.childContinuationToken,
          event: parentEvent,
          request,
          subagent,
        },
      ] as const,
  );
}

function readMap(state: SessionStateMap | undefined): ProxyInputRequestMap {
  const raw = state?.[PROXY_INPUT_REQUESTS_KEY];
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as ProxyInputRequestMap)
    : {};
}

function writeMap(
  session: HarnessSession,
  entries: Readonly<Record<string, ProxyInputRequestEntry>>,
): HarnessSession {
  const state = { ...session.state };

  if (Object.keys(entries).length === 0) {
    delete state[PROXY_INPUT_REQUESTS_KEY];
    return {
      ...session,
      state: Object.keys(state).length > 0 ? state : undefined,
    };
  }

  state[PROXY_INPUT_REQUESTS_KEY] = entries;
  return { ...session, state };
}
