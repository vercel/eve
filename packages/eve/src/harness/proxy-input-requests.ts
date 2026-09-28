import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type { PendingInputBatchEvent } from "#harness/pending-input-batches.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import { inputOptionSchema, type InputOption, type InputRequestKind } from "#shared/input.js";
import {
  isSessionInboxAddress,
  type SessionInboxAddress,
} from "#execution/session-inbox/address.js";

const PROXY_INPUT_REQUESTS_KEY = "eve.runtime.proxyInputRequests";

const PROXY_INPUT_REQUEST_KINDS = {
  question: true,
  "session-limit": true,
  "tool-approval": true,
} satisfies Readonly<Record<InputRequestKind, true>>;

/**
 * Marks a request as a workflow tool run's `ctx.ask()` question, rather than a
 * child session's. Its answer goes to the run's control hook, which carries
 * every decision the session makes for the run, in order.
 */
export interface WorkflowAskRoute {
  readonly control: string;
  /** What a plain-text message may answer. */
  readonly question: ProxyInputQuestion;
  readonly runId: string;
}

/** The parts of a `ctx.ask()` request a plain-text message is resolved against. */
export interface ProxyInputQuestion {
  readonly allowFreeform?: boolean;
  readonly options?: readonly InputOption[];
}

/** Routing and control metadata for one descendant-owned input request. */
export interface ProxyInputRequest {
  readonly workflowAsk?: WorkflowAskRoute;
  /** Batch semantics are optional so sessions written before this field remain routable. */
  readonly batch?: ProxyInputRequestBatch;
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  /**
   * Coordinates of the `input.requested` this session emitted for the request;
   * the `input.resolved` it emits once it routes the answer repeats them.
   */
  readonly event: PendingInputBatchEvent;
  readonly kind: InputRequestKind;
  /** Question metadata lets the human-facing parent resolve plain text before proxying by ID. */
  readonly question?: ProxyInputQuestion;
}

export interface ProxyInputRequestBatch {
  readonly approvalRequestIds: readonly string[];
  readonly requestIds: readonly string[];
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
 * Adds a child batch's routes. Earlier routes stay: a child can have several
 * batches open at once, its own and those it relays for its children, and
 * each route lasts until an answer, withdrawal, or cancellation retires it.
 */
export function upsertProxyInputRequests(input: {
  readonly entries: readonly (readonly [requestId: string, route: ProxyInputRequest])[];
  readonly session: HarnessSession;
}): HarnessSession {
  return writeMap(input.session, {
    ...readMap(input.session.state),
    ...Object.fromEntries(input.entries),
  });
}

/** Removes every proxy route the predicate selects. */
export function clearProxyInputRequestsWhere<T extends { readonly state?: SessionStateMap }>(
  session: T,
  select: (route: ProxyInputRequest) => boolean,
): T {
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
  const batch: ProxyInputRequestBatch = {
    approvalRequestIds: payload.event.requests.flatMap((request) =>
      request.kind === "tool-approval" ? [request.requestId] : [],
    ),
    requestIds: payload.event.requests.map((request) => request.requestId),
  };
  const event: PendingInputBatchEvent = {
    sequence: payload.event.sequence,
    stepIndex: payload.event.stepIndex,
    turnId: payload.event.turnId,
  };
  return payload.event.requests.map((request) => {
    const route: {
      readonly childContinuationToken: string;
      childSessionInbox?: SessionInboxAddress;
      readonly event: PendingInputBatchEvent;
      readonly kind: InputRequestKind;
      question?: ProxyInputQuestion;
    } & { readonly batch: ProxyInputRequestBatch } = {
      batch,
      childContinuationToken: payload.childContinuationToken,
      event,
      kind: request.kind,
    };
    if (request.kind === "question") {
      route.question = {
        ...(request.allowFreeform !== undefined && { allowFreeform: request.allowFreeform }),
        ...(request.options !== undefined && { options: [...request.options] }),
      };
    }
    if (payload.childSessionInbox?.sessionId === payload.childSessionId) {
      route.childSessionInbox = payload.childSessionInbox;
    }

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
  const event = "event" in value ? parseInputRequestEvent(value.event) : undefined;
  if (event === undefined) return undefined;
  const batch = "batch" in value ? parseProxyInputRequestBatch(value.batch) : undefined;
  const workflowAsk = "workflowAsk" in value ? parseWorkflowAskRoute(value.workflowAsk) : undefined;
  if ("workflowAsk" in value && workflowAsk === undefined) return undefined;
  const question = "question" in value ? parseProxyInputQuestion(value.question) : undefined;
  if ("question" in value && question === undefined) return undefined;
  const childSessionInbox = "childSessionInbox" in value ? value.childSessionInbox : undefined;
  if (childSessionInbox !== undefined && !isSessionInboxAddress(childSessionInbox))
    return undefined;
  const request: {
    workflowAsk?: WorkflowAskRoute;
    batch?: ProxyInputRequestBatch;
    readonly childContinuationToken: string;
    childSessionInbox?: SessionInboxAddress;
    readonly event: PendingInputBatchEvent;
    readonly kind: InputRequestKind;
    question?: ProxyInputQuestion;
  } = {
    childContinuationToken: value.childContinuationToken,
    event,
    kind: value.kind,
  };
  if (workflowAsk !== undefined) request.workflowAsk = workflowAsk;
  if (childSessionInbox !== undefined) request.childSessionInbox = childSessionInbox;
  if (batch !== undefined && batch.requestIds.includes(requestId)) request.batch = batch;
  if (question !== undefined) request.question = question;
  return request;
}

function parseInputRequestEvent(value: unknown): PendingInputBatchEvent | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const sequence = Reflect.get(value, "sequence");
  const stepIndex = Reflect.get(value, "stepIndex");
  const turnId = Reflect.get(value, "turnId");
  if (typeof sequence !== "number" || typeof stepIndex !== "number") return undefined;
  if (typeof turnId !== "string") return undefined;
  return { sequence, stepIndex, turnId };
}

function parseWorkflowAskRoute(value: unknown): WorkflowAskRoute | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const control = Reflect.get(value, "control");
  const runId = Reflect.get(value, "runId");
  if (typeof control !== "string" || control.length === 0) return undefined;
  if (typeof runId !== "string" || runId.length === 0) return undefined;
  const question = parseProxyInputQuestion(Reflect.get(value, "question"));
  if (question === undefined) return undefined;
  return { control, question, runId };
}

function parseProxyInputQuestion(value: unknown): ProxyInputQuestion | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const question: {
    allowFreeform?: boolean;
    options?: readonly InputOption[];
  } = {};
  const allowFreeform = Reflect.get(value, "allowFreeform");
  if (allowFreeform !== undefined) {
    if (typeof allowFreeform !== "boolean") return undefined;
    question.allowFreeform = allowFreeform;
  }
  const options = Reflect.get(value, "options");
  if (options !== undefined) {
    const parsed = inputOptionSchema.array().safeParse(options);
    if (!parsed.success) return undefined;
    question.options = parsed.data;
  }
  return question;
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

function isInputRequestKind(value: unknown): value is InputRequestKind {
  return typeof value === "string" && Object.hasOwn(PROXY_INPUT_REQUEST_KINDS, value);
}
