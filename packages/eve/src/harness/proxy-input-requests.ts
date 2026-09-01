import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import type { InputRequestKind } from "#shared/input.js";
import { isLoopbackHostname } from "#shared/network-address.js";

const PROXY_INPUT_REQUESTS_KEY = "eve.runtime.proxyInputRequests";

const PROXY_INPUT_REQUEST_KINDS = {
  question: true,
  "session-limit": true,
  "tool-approval": true,
} satisfies Readonly<Record<InputRequestKind, true>>;

/**
 * Marks a continuation token as a bare hook a workflow tool run created for one
 * request, resumed with the plain response, rather than a child session inbox.
 */
export interface AnswerHookRoute {
  readonly runId: string;
}

/** Routing and control metadata for one descendant-owned input request. */
export interface ProxyInputRequest {
  readonly answerHook?: AnswerHookRoute;
  /** Batch semantics are optional so sessions written before this field remain routable. */
  readonly batch?: ProxyInputRequestBatch;
  readonly childContinuationToken: string;
  /** Child-local id restored before forwarding a namespaced task response. */
  readonly childRequestId?: string;
  /** Trusted parent-derived capability URL for a remote task child. */
  readonly childResponseUrl?: string;
  readonly kind: InputRequestKind;
  /** Present when the route is authorized by a parent-owned durable task. */
  readonly taskId?: string;
}

export interface ProxyInputRequestBatch {
  readonly approvalRequestIds: readonly string[];
  readonly requestIds: readonly string[];
}

/** `requestId → route` map stored on the parent session. */
type ProxyInputRequestMap = Readonly<Record<string, ProxyInputRequest>>;

/** Parent-visible id for one task-owned child-local input request. */
export function createTaskInputRequestId(taskId: string, childRequestId: string): string {
  return `${taskId}:${childRequestId}`;
}

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
 * Replaces prior entries for `forChildContinuationToken` with the provided
 * ones. A child raising a fresh batch overwrites its prior batch so the
 * parent never keeps stale request metadata. Other children's routes stay
 * independently answerable.
 */
export function upsertProxyInputRequests(input: {
  readonly entries: readonly (readonly [requestId: string, route: ProxyInputRequest])[];
  readonly forChildContinuationToken: string;
  readonly session: HarnessSession;
}): HarnessSession {
  return {
    ...input.session,
    state: upsertProxyInputRequestState({
      entries: input.entries,
      forChildContinuationToken: input.forChildContinuationToken,
      state: input.session.state,
    }),
  };
}

/** State-only variant for control-plane steps that already hold a durable projection. */
export function upsertProxyInputRequestState(input: {
  readonly entries: readonly (readonly [requestId: string, route: ProxyInputRequest])[];
  readonly forChildContinuationToken: string;
  readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined {
  const next: Record<string, ProxyInputRequest> = {};

  for (const [requestId, route] of Object.entries(readMap(input.state))) {
    if (route.childContinuationToken !== input.forChildContinuationToken) {
      next[requestId] = route;
    }
  }

  for (const [requestId, route] of input.entries) {
    next[requestId] = route;
  }

  const state = { ...input.state };
  if (Object.keys(next).length === 0) {
    delete state[PROXY_INPUT_REQUESTS_KEY];
  } else {
    state[PROXY_INPUT_REQUESTS_KEY] = next;
  }
  return Object.keys(state).length > 0 ? state : undefined;
}

/**
 * Removes every entry for `childContinuationToken`. Called when a
 * child subagent finishes so stale clicks no longer route to it.
 */
export function clearProxyInputRequestsForChild(
  session: HarnessSession,
  childContinuationToken: string,
): HarnessSession {
  return clearProxyInputRequestsWhere(
    session,
    (route) => route.childContinuationToken === childContinuationToken,
  );
}

/** Removes every proxy route the predicate selects. */
export function clearProxyInputRequestsWhere(
  session: HarnessSession,
  select: (route: ProxyInputRequest) => boolean,
): HarnessSession {
  const current = readMap(session.state);
  const next: Record<string, ProxyInputRequest> = {};
  let changed = false;

  for (const [requestId, route] of Object.entries(current)) {
    if (select(route)) {
      changed = true;
      continue;
    }
    next[requestId] = route;
  }

  return changed ? writeMap(session, next) : session;
}

/** Removes only the request IDs whose responses were successfully forwarded. */
export function retireProxyInputRequests<T extends { readonly state?: SessionStateMap }>(
  session: T,
  requestIds: readonly string[],
): T {
  const current = readMap(session.state);
  const next = { ...current };
  let changed = false;

  for (const requestId of requestIds) {
    if (Object.hasOwn(next, requestId)) {
      delete next[requestId];
      changed = true;
    }
  }

  return changed ? writeMap(session, next) : session;
}

/** Removes every proxy route owned by one durable task. */
export function clearProxyInputRequestsForTask(
  session: HarnessSession,
  taskId: string,
): HarnessSession {
  return clearProxyInputRequestsWhere(session, (route) => route.taskId === taskId);
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
  taskId?: string,
): readonly (readonly [requestId: string, route: ProxyInputRequest])[] {
  const batch: ProxyInputRequestBatch = {
    approvalRequestIds: payload.event.requests.flatMap((request) =>
      request.kind === "tool-approval" ? [request.requestId] : [],
    ),
    requestIds: payload.event.requests.map((request) => request.requestId),
  };
  return payload.event.requests.map((request) => {
    const route: {
      readonly childContinuationToken: string;
      childResponseUrl?: string;
      readonly kind: InputRequestKind;
      taskId?: string;
    } & { readonly batch: ProxyInputRequestBatch } = {
      batch,
      childContinuationToken: payload.childContinuationToken,
      kind: request.kind,
    };
    if (taskId !== undefined) route.taskId = taskId;

    return [request.requestId, route] as const;
  });
}

function readMap(state: SessionStateMap | undefined): ProxyInputRequestMap {
  const raw = state?.[PROXY_INPUT_REQUESTS_KEY];

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const result: Record<string, ProxyInputRequest> = {};
  for (const [key, value] of Object.entries(raw)) {
    const request = parseProxyInputRequest(value, key);
    if (request !== undefined) {
      result[key] = request;
    }
  }
  return result;
}

function writeMap<T extends { readonly state?: SessionStateMap }>(
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

function parseProxyInputRequest(value: unknown, requestId: string): ProxyInputRequest | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  if (!("childContinuationToken" in value) || !("kind" in value)) {
    return undefined;
  }
  if (typeof value.childContinuationToken !== "string" || !isInputRequestKind(value.kind)) {
    return undefined;
  }
  const taskId = "taskId" in value ? value.taskId : undefined;
  const childRequestId = "childRequestId" in value ? value.childRequestId : undefined;
  const childResponseUrl = "childResponseUrl" in value ? value.childResponseUrl : undefined;
  if (taskId !== undefined && (typeof taskId !== "string" || taskId.length === 0)) {
    return undefined;
  }
  if (
    childRequestId !== undefined &&
    (typeof childRequestId !== "string" || childRequestId.length === 0)
  ) {
    return undefined;
  }
  if ((taskId === undefined) !== (childRequestId === undefined)) return undefined;
  if (
    childResponseUrl !== undefined &&
    (typeof childResponseUrl !== "string" || !isAllowedChildResponseUrl(childResponseUrl))
  ) {
    return undefined;
  }
  const batch = "batch" in value ? parseProxyInputRequestBatch(value.batch) : undefined;
  const answerHook = "answerHook" in value ? parseAnswerHookRoute(value.answerHook) : undefined;
  if ("answerHook" in value && answerHook === undefined) return undefined;
  const request: {
    answerHook?: AnswerHookRoute;
    batch?: ProxyInputRequestBatch;
    readonly childContinuationToken: string;
    childRequestId?: string;
    childResponseUrl?: string;
    readonly kind: InputRequestKind;
    taskId?: string;
  } = {
    childContinuationToken: value.childContinuationToken,
    kind: value.kind,
  };
  if (answerHook !== undefined) request.answerHook = answerHook;
  if (batch !== undefined && batch.requestIds.includes(requestId)) request.batch = batch;
  if (typeof childRequestId === "string") request.childRequestId = childRequestId;
  if (typeof childResponseUrl === "string") request.childResponseUrl = childResponseUrl;
  if (typeof taskId === "string") request.taskId = taskId;
  return request;
}

function parseAnswerHookRoute(value: unknown): AnswerHookRoute | undefined {
  if (value === null || typeof value !== "object" || !("runId" in value)) return undefined;
  return typeof value.runId === "string" && value.runId.length > 0
    ? { runId: value.runId }
    : undefined;
}

function parseProxyInputRequestBatch(value: unknown): ProxyInputRequestBatch | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!("approvalRequestIds" in value) || !("requestIds" in value)) return undefined;
  if (!isStringArray(value.approvalRequestIds) || !isStringArray(value.requestIds))
    return undefined;
  const requestIds = new Set(value.requestIds);
  if (
    requestIds.size !== value.requestIds.length ||
    value.approvalRequestIds.some((requestId) => !requestIds.has(requestId))
  ) {
    return undefined;
  }
  return { approvalRequestIds: value.approvalRequestIds, requestIds: value.requestIds };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isAllowedChildResponseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHostname(url.hostname);
}

function isInputRequestKind(value: unknown): value is InputRequestKind {
  return typeof value === "string" && Object.hasOwn(PROXY_INPUT_REQUEST_KINDS, value);
}
