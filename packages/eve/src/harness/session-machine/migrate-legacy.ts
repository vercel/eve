export const STATE_KEY = "eve.harness.humanInput";
export const LEGACY_BATCH_KEY = "eve.runtime.pendingCoordinationBatch";
export const LEGACY_GRANTS_KEY = "eve.runtime.hitl.approvedTools";
import type { WorkflowAskRoute, ProxyInputQuestion } from "#harness/hitl/index.js";
import type { StepCoordinates as PendingInputBatchEvent } from "#harness/session-machine/view.js";
import { inputOptionSchema, type InputOption, type InputRequestKind } from "#shared/input.js";
import {
  isSessionInboxAddress,
  type SessionInboxAddress,
} from "#execution/session-inbox/address.js";
import type { RemoteAgentBinding } from "#eve-channel/support.js";

/**
 * Reading human input's state, upgrading what earlier releases stored: grants
 * under the old approved-tools key, a batch parked under the old coordination
 * key, and responders' authorizations that were requests of their own. Kept
 * apart from `state.ts` because upgrading uses the rules, and the state's
 * shapes must not depend on them.
 */
import type { ApprovalAudit } from "#harness/hitl/index.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { ModelMessage } from "ai";

import type { SessionStateMap, StepInput } from "#harness/types.js";

import { createInputRequestedEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import type { InputRequest } from "#shared/input.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";

import { withResult } from "./transitions.js";
import type { RequestAt } from "#harness/hitl/input.js";
import { parseState, type HeldStep, type HumanInputState } from "#harness/hitl/state.js";

/**
 * The session's human input. A session parked on runtime calls before the
 * held step held them has them under the old coordination key, with its
 * response there: they become the held step, which its approvals' step
 * already was when it had any.
 */
export function readState(sessionState: SessionStateMap | undefined): HumanInputState {
  const state = withLegacyGrants(
    // Responders' authorizations were once requests of their own.
    adoptCandidateAuthorizations(parseState(sessionState?.[STATE_KEY])),
    sessionState?.[LEGACY_GRANTS_KEY],
  );
  const legacy = parseLegacyBatch(sessionState?.[LEGACY_BATCH_KEY]);
  if (legacy === undefined) return state;
  const { held } = state;
  const step: HeldStep = {
    at: held?.at ?? legacy.event,
    messages: (held?.messages ?? []).reduce<ModelMessage[]>(
      (messages, message) =>
        message.role === "tool"
          ? message.content.reduce<ModelMessage[]>(
              (joined, part) => (part.type === "tool-result" ? withResult(joined, part) : joined),
              messages,
            )
          : [...messages, message],
      [...legacy.responseMessages],
    ),
    runtime: { tasks: [...(held?.runtime?.tasks ?? []), ...legacy.tasks] },
    ...(legacy.followingInput !== undefined && { following: legacy.followingInput }),
  };
  return { ...state, held: step };
}

/** Grants a session stored before `HumanInput` stay granted. */
function withLegacyGrants(state: HumanInputState, value: unknown): HumanInputState {
  if (!Array.isArray(value)) return state;
  const legacy = value.filter((key): key is string => typeof key === "string");
  const grants = [...new Set([...state.grants, ...legacy])];
  return grants.length === state.grants.length ? state : { ...state, grants };
}

interface LegacyBatch {
  readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  readonly event: RequestAt;
  readonly responseMessages: readonly ModelMessage[];
  readonly followingInput?: StepInput;
}

export function parseLegacyBatch(value: unknown): LegacyBatch | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const batch = value as LegacyBatch;
  if (
    !Array.isArray(batch.tasks) ||
    !Array.isArray(batch.responseMessages) ||
    typeof batch.event !== "object" ||
    batch.event === null
  ) {
    return undefined;
  }
  return batch;
}

/** Upgrade keys are inspected only at hydration; the replacement is saved as one state map. */
export const LEGACY_PARKING_KEYS = [
  STATE_KEY,
  LEGACY_BATCH_KEY,
  LEGACY_GRANTS_KEY,
  "eve.runtime.proxyInputRequests",
  "eve.runtime.hitl.approvalState",
] as const;

export function hasLegacyParkingState(state: SessionStateMap | undefined): boolean {
  return LEGACY_PARKING_KEYS.some((key) => state !== undefined && Object.hasOwn(state, key));
}

/** Removing keys and installing their replacement must be part of the same checkpoint write. */
export function clearLegacyParkingState(
  state: SessionStateMap | undefined,
): SessionStateMap | undefined {
  const next = { ...state };
  for (const key of LEGACY_PARKING_KEYS) delete next[key];
  return Object.keys(next).length === 0 ? undefined : next;
}

/** Restore routing facts absent from older checkpoints, without republishing their requests. */
export function legacyRequestedEvents(
  state: SessionStateMap | undefined,
  projection: SessionProjection,
): readonly UnstampedMessageStreamEvent[] {
  const events: UnstampedMessageStreamEvent[] = [];
  for (const open of Object.values(readState(state).requests)) {
    if (open.kind === "authorization" || projection.inputs[open.request.requestId] !== undefined)
      continue;
    events.push(createInputRequestedEvent({ ...open.at, requests: [open.request] }));
  }
  for (const [requestId, route] of getProxyInputRequests(state)) {
    if (
      projection.inputs[requestId] !== undefined ||
      events.some(
        (event) =>
          event.type === "input.requested" &&
          event.data.requests.some((request) => request.requestId === requestId),
      )
    )
      continue;
    // The old routing record kept question metadata, not the original action. This synthetic
    // request is routing-only: it is never republished or treated as an owned approval.
    const request: InputRequest = {
      action: { kind: "tool-call", callId: requestId, toolName: "", input: {} },
      kind: route.kind,
      prompt: "",
      requestId,
      allowFreeform: (route.workflowAsk?.question ?? route.question)?.allowFreeform,
      options:
        (route.workflowAsk?.question ?? route.question)?.options === undefined
          ? undefined
          : [...((route.workflowAsk?.question ?? route.question)?.options ?? [])],
    };
    events.push(createInputRequestedEvent({ ...route.event, requests: [request] }));
  }
  return events;
}

export const APPROVAL_STATE_KEY = "eve.runtime.hitl.approvalState";

type ApprovalCandidateStatus =
  | "pending"
  | "authorization-required"
  | "allowed"
  | "rejected"
  | "failed"
  | "timed-out"
  | "stale";

/** What a responder submitted: a candidate settles its request this way once allowed. */
type ApprovalCandidateDecision = "approve" | "cancel";

interface ApprovalCandidateAuditRecord {
  readonly candidateId: string;
  readonly decision: ApprovalCandidateDecision;
  readonly requestId: string;
  readonly responder: ApprovalResponderIdentity;
  readonly status: ApprovalCandidateStatus;
  readonly createdAt: number;
  readonly completedAt?: number;
  readonly expiresAt?: number;
  readonly reason?: string;
}

interface ApprovalResponderIdentity {
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
  readonly principalType: string;
}

interface ApprovalSettlementAuditRecord {
  readonly actor: ApprovalResponderIdentity;
  /** The approver's full auth, which the approved call runs as. Absent for cancellations. */
  readonly approver?: SessionAuthContext;
  readonly outcome: "allowed" | "cancelled";
  readonly requestId: string;
  readonly settledAt: number;
  readonly candidateId?: string;
}

interface ActiveApprovalCandidate {
  readonly candidateId: string;
  readonly decision: ApprovalCandidateDecision;
  readonly requestId: string;
  readonly responder: SessionAuthContext;
  readonly status: "pending" | "authorization-required";
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly authorizationChallenges?: readonly AuthorizationChallenge[];
}

interface DurableApprovalState {
  readonly activeCandidates: Readonly<Record<string, ActiveApprovalCandidate>>;
  readonly nextCandidateSequence: number;
  readonly candidateHistory: readonly ApprovalCandidateAuditRecord[];
  readonly settlements: Readonly<Record<string, ApprovalSettlementAuditRecord>>;
}

/**
 * A candidate is an Approve unless it records Cancel: candidates persisted
 * before Cancel was authorized carry no decision, and their responder pressed
 * Approve.
 */
function readActiveCandidates(
  candidates: Readonly<Record<string, ActiveApprovalCandidate>>,
): Readonly<Record<string, ActiveApprovalCandidate>> {
  return Object.fromEntries(
    Object.entries(candidates).map(([candidateId, candidate]) => [
      candidateId,
      { ...candidate, decision: candidate.decision === "cancel" ? "cancel" : "approve" },
    ]),
  );
}

function readApprovalState(state: SessionStateMap | undefined): DurableApprovalState {
  const value = state?.[APPROVAL_STATE_KEY];
  if (typeof value !== "object" || value === null) {
    return {
      activeCandidates: {},
      candidateHistory: [],
      nextCandidateSequence: 0,
      settlements: {},
    };
  }
  const candidate = value as Partial<DurableApprovalState>;
  return {
    activeCandidates:
      typeof candidate.activeCandidates === "object" && candidate.activeCandidates !== null
        ? readActiveCandidates(candidate.activeCandidates)
        : {},
    candidateHistory: Array.isArray(candidate.candidateHistory) ? candidate.candidateHistory : [],
    nextCandidateSequence:
      typeof candidate.nextCandidateSequence === "number" &&
      Number.isSafeInteger(candidate.nextCandidateSequence) &&
      candidate.nextCandidateSequence >= 0
        ? candidate.nextCandidateSequence
        : deriveNextCandidateSequence(candidate),
    settlements:
      typeof candidate.settlements === "object" && candidate.settlements !== null
        ? candidate.settlements
        : {},
  };
}

function deriveNextCandidateSequence(state: Partial<DurableApprovalState>): number {
  return (
    Object.keys(state.activeCandidates ?? {}).length +
    (Array.isArray(state.candidateHistory) ? state.candidateHistory.length : 0)
  );
}

/** Main's audit keeps timestamps too; retain them while renaming candidate challenges. */
function approvalAudit(state: DurableApprovalState): ApprovalAudit {
  return {
    ...state,
    activeCandidates: Object.fromEntries(
      Object.entries(state.activeCandidates).map(([id, candidate]) => {
        const { authorizationChallenges, ...rest } = candidate;
        return [id, { ...rest, authorizations: authorizationChallenges }];
      }),
    ),
    candidateHistory: state.candidateHistory as ApprovalAudit["candidateHistory"],
  };
}

/** Read only the old key: the machine audit must not mask an upgrade's source. */
export function legacyApprovalAudit(state: SessionStateMap | undefined): ApprovalAudit | undefined {
  return state?.[APPROVAL_STATE_KEY] === undefined
    ? undefined
    : approvalAudit(readApprovalState({ [APPROVAL_STATE_KEY]: state[APPROVAL_STATE_KEY] }));
}

/**
 * Audit wins on duplicate candidate/request ids and on an existing sequence counter.
 * History is keyed by candidate id, so repeated hydration never appends duplicates.
 */
export function mergeApprovalAudits(
  legacy: ApprovalAudit | undefined,
  audit: ApprovalAudit | undefined,
): ApprovalAudit | undefined {
  if (legacy === undefined) return audit;
  if (audit === undefined) return legacy;
  return {
    activeCandidates: { ...legacy.activeCandidates, ...audit.activeCandidates },
    candidateHistory: [
      ...legacy.candidateHistory.filter(
        (entry) =>
          !audit.candidateHistory.some((current) => current.candidateId === entry.candidateId),
      ),
      ...audit.candidateHistory,
    ],
    nextCandidateSequence: audit.nextCandidateSequence,
    settlements: { ...legacy.settlements, ...audit.settlements },
  };
}

export const PROXY_INPUT_REQUESTS_KEY = "eve.runtime.proxyInputRequests";

const PROXY_INPUT_REQUEST_KINDS = {
  question: true,
  "session-limit": true,
  "tool-approval": true,
} satisfies Readonly<Record<InputRequestKind, true>>;

/** Routing and control metadata for one descendant-owned input request. */
export interface ProxyInputRequest {
  readonly remote?: RemoteAgentBinding & { readonly sessionId: string };
  readonly inputSource?: string;
  readonly workflowAsk?: WorkflowAskRoute;
  /**
   * The workflow tool run that relayed the request: its own `ctx.ask()`
   * question, or a request from a session it opened with `ctx.agent`. Nobody
   * can answer the request once that run ends.
   */
  readonly runId?: string;
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
  const remote = "remote" in value ? parseRemoteAgentBinding(value.remote) : undefined;
  if ("remote" in value && remote === undefined) return undefined;
  const inputSource = "inputSource" in value ? value.inputSource : undefined;
  if (inputSource !== undefined && (typeof inputSource !== "string" || inputSource.length === 0))
    return undefined;
  const event = "event" in value ? parseInputRequestEvent(value.event) : undefined;
  if (event === undefined) return undefined;
  const batch = "batch" in value ? parseProxyInputRequestBatch(value.batch) : undefined;
  const workflowAsk = "workflowAsk" in value ? parseWorkflowAskRoute(value.workflowAsk) : undefined;
  if ("workflowAsk" in value && workflowAsk === undefined) return undefined;
  const runId = "runId" in value ? value.runId : undefined;
  if (runId !== undefined && (typeof runId !== "string" || runId.length === 0)) return undefined;
  const question = "question" in value ? parseProxyInputQuestion(value.question) : undefined;
  if ("question" in value && question === undefined) return undefined;
  const childSessionInbox = "childSessionInbox" in value ? value.childSessionInbox : undefined;
  if (childSessionInbox !== undefined && !isSessionInboxAddress(childSessionInbox))
    return undefined;
  const request: {
    workflowAsk?: WorkflowAskRoute;
    runId?: string;
    batch?: ProxyInputRequestBatch;
    readonly childContinuationToken: string;
    inputSource?: string;
    remote?: RemoteAgentBinding & { readonly sessionId: string };
    childSessionInbox?: SessionInboxAddress;
    readonly event: PendingInputBatchEvent;
    readonly kind: InputRequestKind;
    question?: ProxyInputQuestion;
  } = {
    childContinuationToken: value.childContinuationToken,
    event,
    kind: value.kind,
  };
  if (typeof inputSource === "string") request.inputSource = inputSource;
  if (remote !== undefined) request.remote = remote;
  if (workflowAsk !== undefined) request.workflowAsk = workflowAsk;
  if (typeof runId === "string") request.runId = runId;
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
  if (typeof control !== "string" || control.length === 0) return undefined;
  const question = parseProxyInputQuestion(Reflect.get(value, "question"));
  if (question === undefined) return undefined;
  return { control, question };
}

function parseRemoteAgentBinding(
  value: unknown,
): (RemoteAgentBinding & { readonly sessionId: string }) | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const name = Reflect.get(value, "name");
  const url = Reflect.get(value, "url");
  const resolverId = Reflect.get(value, "resolverId");
  const forwardPrincipal = Reflect.get(value, "forwardPrincipal");
  const sessionId = Reflect.get(value, "sessionId");
  if (
    typeof name !== "string" ||
    !name ||
    typeof url !== "string" ||
    !url ||
    typeof sessionId !== "string" ||
    !sessionId
  )
    return undefined;
  if (resolverId !== undefined && (typeof resolverId !== "string" || !resolverId)) return undefined;
  if (forwardPrincipal !== undefined && typeof forwardPrincipal !== "boolean") return undefined;
  return {
    name,
    url,
    sessionId,
    ...(resolverId !== undefined && { resolverId }),
    ...(forwardPrincipal !== undefined && { forwardPrincipal }),
  };
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

/** Old responder sign-ins become candidate-owned metadata at hydration only. */
function adoptCandidateAuthorizations(state: HumanInputState): HumanInputState {
  const requests = { ...state.requests };
  const activeCandidates = { ...state.audit?.activeCandidates };
  let changed = false;
  for (const [id, open] of Object.entries(requests)) {
    if (open.kind !== "authorization" || open.challenge.candidateId === undefined) continue;
    delete requests[id];
    changed = true;
    const candidate = activeCandidates[open.challenge.candidateId];
    if (candidate !== undefined)
      activeCandidates[candidate.candidateId] = {
        ...candidate,
        authorizations: [...(candidate.authorizations ?? []), open.challenge],
        status: "authorization-required",
      };
  }
  return !changed
    ? state
    : {
        ...state,
        requests,
        ...(state.audit !== undefined && { audit: { ...state.audit, activeCandidates } }),
      };
}
