import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type { InputResolvedStreamEvent } from "#protocol/message.js";
import type { StepCoordinates as PendingInputBatchEvent } from "#harness/session-machine/view.js";
import type { InputOption, InputRequestKind } from "#shared/input.js";
import {
  isSessionInboxAddress,
  type SessionInboxAddress,
} from "#execution/session-inbox/address.js";
import type { RemoteAgentBinding } from "#eve-channel/support.js";

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
}

/** The parts of a request a plain-text reply is resolved against. */
export interface ProxyInputReply {
  readonly allowFreeform?: boolean;
  readonly options?: readonly InputOption[];
}

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
  /** Lets the human-facing parent resolve a plain-text reply before proxying it by ID. */
  readonly reply?: ProxyInputReply;
}

export interface ProxyInputRequestBatch {
  readonly approvalRequestIds: readonly string[];
  readonly requestIds: readonly string[];
}

/**
 * Whether the child, not this session, closes a relayed request. A child's tool approval can
 * refuse the person who answered, so it stays open here until the child's own `input.resolved`
 * or `approval.settled` arrives. This session closes every other relayed request once it
 * forwards the answer.
 */
export function resolvedByChild(kind: InputRequestKind): boolean {
  return kind === "tool-approval";
}

/**
 * The part of a child's `input.resolved` its parent relays: the requests the parent leaves for
 * the child to close. `undefined` when the parent already closed all of them.
 */
export function resolvedForParent(
  data: InputResolvedStreamEvent["data"],
): InputResolvedStreamEvent["data"] | undefined {
  const resolutions = data.resolutions.filter(({ kind }) => resolvedByChild(kind));
  return resolutions.length === 0 ? undefined : { ...data, resolutions };
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
      readonly inputSource?: string;
      readonly remote?: RemoteAgentBinding & { readonly sessionId: string };
      childSessionInbox?: SessionInboxAddress;
      readonly event: PendingInputBatchEvent;
      readonly kind: InputRequestKind;
      readonly reply: ProxyInputReply;
    } & { readonly batch: ProxyInputRequestBatch } = {
      batch,
      childContinuationToken: payload.childContinuationToken,
      ...(payload.inputSource !== undefined && { inputSource: payload.inputSource }),
      ...(payload.remote !== undefined && { remote: payload.remote }),
      event,
      kind: request.kind,
      reply: {
        ...(request.allowFreeform !== undefined && { allowFreeform: request.allowFreeform }),
        ...(request.options !== undefined && { options: [...request.options] }),
      },
    };
    if (payload.childSessionInbox?.sessionId === payload.childSessionId) {
      route.childSessionInbox = payload.childSessionInbox;
    }

    return [request.requestId, route] as const;
  });
}

/** Reads one stored route, or `undefined` when it is malformed. */
export function parseProxyInputRequest(
  value: unknown,
  requestId: string,
): ProxyInputRequest | undefined {
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
  const reply = "reply" in value ? parseProxyInputReply(value.reply) : undefined;
  if ("reply" in value && reply === undefined) return undefined;
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
    reply?: ProxyInputReply;
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
  if (reply !== undefined) request.reply = reply;
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
  return { control };
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

function parseProxyInputReply(value: unknown): ProxyInputReply | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const reply: {
    allowFreeform?: boolean;
    options?: readonly InputOption[];
  } = {};
  const allowFreeform = Reflect.get(value, "allowFreeform");
  if (allowFreeform !== undefined) {
    if (typeof allowFreeform !== "boolean") return undefined;
    reply.allowFreeform = allowFreeform;
  }
  const options = Reflect.get(value, "options");
  if (options !== undefined) {
    // `Array.from` turns holes into `undefined`, which `every` alone would skip.
    if (!Array.isArray(options) || !Array.from(options).every(isInputOption)) return undefined;
    reply.options = options;
  }
  return reply;
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

// `inputOptionSchema`, checked by hand: the session-state module imports this one, and the
// workflow bundle reads session state without pulling in zod.
const INPUT_OPTION_FIELDS: Readonly<Record<string, (value: unknown) => boolean>> = {
  description: (value) => value === undefined || typeof value === "string",
  id: (value) => typeof value === "string",
  label: (value) => typeof value === "string",
  style: (value) =>
    value === undefined || value === "primary" || value === "danger" || value === "default",
};

function isInputOption(value: unknown): value is InputOption {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    Object.keys(value).every((key) => Object.hasOwn(INPUT_OPTION_FIELDS, key)) &&
    Object.entries(INPUT_OPTION_FIELDS).every(([key, valid]) => valid(Reflect.get(value, key)))
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isInputRequestKind(value: unknown): value is InputRequestKind {
  return typeof value === "string" && Object.hasOwn(PROXY_INPUT_REQUEST_KINDS, value);
}
