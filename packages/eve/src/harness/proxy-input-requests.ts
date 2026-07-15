import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";

const PROXY_INPUT_REQUESTS_KEY = "eve.runtime.proxyInputRequests";

/** `requestId → childContinuationToken` map stored on the parent session. */
type ProxyInputRequestMap = Readonly<Record<string, string>>;

/**
 * Returns the proxy-routing map as a fresh `Map`. Never returns a live
 * reference so accidental mutation cannot corrupt session state.
 */
export function getProxyInputRequests(
  state: SessionStateMap | undefined,
): ReadonlyMap<string, string> {
  return new Map(Object.entries(readMap(state)));
}

/**
 * Returns true when the session is currently proxying one or more
 * HITL requests on behalf of a descendant subagent.
 */
export function hasProxyInputRequests(state: SessionStateMap | undefined): boolean {
  for (const _ of Object.keys(readMap(state))) {
    return true;
  }
  return false;
}

/**
 * Replaces prior entries for `forChildContinuationToken` with the
 * provided ones. A child raising a fresh batch overwrites its prior
 * batch — the parent never keeps stale request metadata.
 */
export function upsertProxyInputRequests(input: {
  readonly entries: readonly (readonly [requestId: string, childContinuationToken: string])[];
  readonly forChildContinuationToken: string;
  readonly session: HarnessSession;
}): HarnessSession {
  const next: Record<string, string> = {};

  for (const [requestId, childToken] of Object.entries(readMap(input.session.state))) {
    if (childToken !== input.forChildContinuationToken) {
      next[requestId] = childToken;
    }
  }

  for (const [requestId, childToken] of input.entries) {
    next[requestId] = childToken;
  }

  return writeMap(input.session, next);
}

/**
 * Removes every entry for `childContinuationToken`. Called when a
 * child subagent finishes so stale clicks no longer route to it.
 */
export function clearProxyInputRequestsForChild(
  session: HarnessSession,
  childContinuationToken: string,
): HarnessSession {
  const current = readMap(session.state);
  const next: Record<string, string> = {};
  let changed = false;

  for (const [requestId, childToken] of Object.entries(current)) {
    if (childToken === childContinuationToken) {
      changed = true;
      continue;
    }
    next[requestId] = childToken;
  }

  if (!changed) {
    return session;
  }

  return writeMap(session, next);
}

/**
 * Removes every proxy entry. Called when a cancelled turn orphans its
 * descendants so stale HITL responses no longer route to them.
 */
export function clearAllProxyInputRequests(session: HarnessSession): HarnessSession {
  if (!hasProxyInputRequests(session.state)) {
    return session;
  }
  return writeMap(session, {});
}

/**
 * Projects a {@link SubagentInputRequestHookPayload} into the
 * `(requestId, childContinuationToken)` tuples the session stores.
 */
export function toProxyInputRequestEntries(
  payload: SubagentInputRequestHookPayload,
): readonly (readonly [requestId: string, childContinuationToken: string])[] {
  return payload.event.requests.map(
    (request) => [request.requestId, payload.childContinuationToken] as const,
  );
}

function readMap(state: SessionStateMap | undefined): ProxyInputRequestMap {
  const raw = state?.[PROXY_INPUT_REQUESTS_KEY];

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

function writeMap(session: HarnessSession, entries: Record<string, string>): HarnessSession {
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
