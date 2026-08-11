import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import {
  inputRequestSchema,
  type InputRequest,
  type InputRequestKind,
} from "#runtime/input/types.js";

const PROXY_INPUT_REQUESTS_KEY = "eve.runtime.proxyInputRequests";

const PROXY_INPUT_REQUEST_KINDS = {
  question: true,
  "session-limit": true,
  "tool-approval": true,
} satisfies Readonly<Record<InputRequestKind, true>>;

/** Routing and control metadata for one descendant-owned input request. */
export interface ProxyInputRequest {
  /** The response was forwarded; retain the entry until child settlement for lifecycle tracking. */
  readonly answered?: true;
  readonly childContinuationToken: string;
  readonly kind: InputRequestKind;
  /** Present for new requests; absent on sessions created before request metadata was stored. */
  readonly request?: InputRequest;
}

interface SessionWithState {
  readonly state?: SessionStateMap;
}

/** `requestId → route` map stored on the parent session. */
type ProxyInputRequestMap = Readonly<Record<string, ProxyInputRequest>>;

/**
 * Returns the proxy-routing map as a fresh `Map`. Never returns a live
 * reference so accidental mutation cannot corrupt session state.
 */
export function getProxyInputRequests(
  state: SessionStateMap | undefined,
): ReadonlyMap<string, ProxyInputRequest> {
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
  readonly entries: readonly (readonly [requestId: string, route: ProxyInputRequest])[];
  readonly forChildContinuationToken: string;
  readonly session: HarnessSession;
}): HarnessSession {
  const next: Record<string, ProxyInputRequest> = {};

  for (const [requestId, route] of Object.entries(readMap(input.session.state))) {
    if (route.childContinuationToken !== input.forChildContinuationToken) {
      next[requestId] = route;
    }
  }

  for (const [requestId, route] of input.entries) {
    next[requestId] = route;
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
  const next: Record<string, ProxyInputRequest> = {};
  let changed = false;

  for (const [requestId, route] of Object.entries(current)) {
    if (route.childContinuationToken === childContinuationToken) {
      changed = true;
      continue;
    }
    next[requestId] = route;
  }

  if (!changed) {
    return session;
  }

  return writeMap(session, next);
}

/** Marks routed entries answered while retaining descendant-wait lifecycle state. */
export function markProxyInputRequestsAnswered<T extends SessionWithState>(
  session: T,
  requestIds: ReadonlySet<string>,
): T {
  if (requestIds.size === 0) {
    return session;
  }

  const current = readMap(session.state);
  const next: Record<string, ProxyInputRequest> = {};
  let changed = false;

  for (const [requestId, route] of Object.entries(current)) {
    if (requestIds.has(requestId) && route.answered !== true) {
      changed = true;
      next[requestId] = { ...route, answered: true };
    } else {
      next[requestId] = route;
    }
  }

  return changed ? writeMap(session, next) : session;
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
 * `(requestId, route)` tuples the session stores.
 */
export function toProxyInputRequestEntries(
  payload: SubagentInputRequestHookPayload,
): readonly (readonly [requestId: string, route: ProxyInputRequest])[] {
  return payload.event.requests.map(
    (request) =>
      [
        request.requestId,
        {
          childContinuationToken: payload.childContinuationToken,
          kind: request.kind,
          request,
        },
      ] as const,
  );
}

function readMap(state: SessionStateMap | undefined): ProxyInputRequestMap {
  const raw = state?.[PROXY_INPUT_REQUESTS_KEY];

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const result: Record<string, ProxyInputRequest> = {};
  for (const [key, value] of Object.entries(raw)) {
    const request = parseProxyInputRequest(value);
    if (request !== undefined) {
      result[key] = request;
    }
  }
  return result;
}

function writeMap<T extends SessionWithState>(
  session: T,
  entries: Record<string, ProxyInputRequest>,
): T {
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

function parseProxyInputRequest(value: unknown): ProxyInputRequest | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  if (!("childContinuationToken" in value) || !("kind" in value)) {
    return undefined;
  }
  if (typeof value.childContinuationToken !== "string" || !isInputRequestKind(value.kind)) {
    return undefined;
  }
  const request = "request" in value ? inputRequestSchema.safeParse(value.request) : undefined;
  const answered = "answered" in value && value.answered === true;
  return {
    ...(answered ? { answered: true as const } : {}),
    childContinuationToken: value.childContinuationToken,
    kind: value.kind,
    ...(request?.success === true ? { request: request.data } : {}),
  };
}

function isInputRequestKind(value: unknown): value is InputRequestKind {
  return typeof value === "string" && Object.hasOwn(PROXY_INPUT_REQUEST_KINDS, value);
}
