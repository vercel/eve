import type { SessionInboxAddress } from "#execution/session-inbox/address.js";
import type {
  DeliverPayload,
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { resolveInputOutcome } from "#harness/input-request-resolution.js";
import type { PendingInputBatchEvent } from "#harness/pending-input-batches.js";
import {
  getProxyInputRequests,
  toProxyInputRequestEntries,
} from "#harness/proxy-input-requests.js";
import type { WorkflowAskRoute, ProxyInputRequest } from "#harness/proxy-input-requests.js";
import type { HarnessEmitFn, HarnessSession, SessionStateMap } from "#harness/types.js";
import {
  createInputRequestedEvent,
  createTurnWaitingEvent,
  type InputResolution,
} from "#protocol/message.js";
import type { InputResponse } from "#shared/input.js";
import { resolveTextToResponse } from "#channel/resolve-text.js";
import { SESSION_LIMIT_STOP_OPTION_ID } from "#harness/session-limit-continuation.js";

// ---------------------------------------------------------------------------
// Upward proxy emission
// ---------------------------------------------------------------------------

/**
 * Runs the parent-side work for a `subagent-input-request`: emits the request,
 * then `turn.waiting` for the parent's open turn. The call that asked is still
 * running, so the turn stays open until the answer lets that call settle. The
 * returned proxy entries route the eventual response back down to the asker.
 */
export async function emitProxiedInputRequest(input: {
  readonly emit: HarnessEmitFn;
  readonly hookPayload: SubagentInputRequestHookPayload;
  readonly session: HarnessSession;
}): Promise<readonly (readonly [requestId: string, route: ProxyInputRequest])[]> {
  await input.emit(
    createInputRequestedEvent({
      requests: input.hookPayload.event.requests,
      sequence: input.hookPayload.event.sequence,
      stepIndex: input.hookPayload.event.stepIndex,
      turnId: input.hookPayload.event.turnId,
    }),
  );
  await emitTurnWaiting(input.emit, input.session);
  return toProxyInputRequestEntries(input.hookPayload);
}

/**
 * Runs the parent-side work for a `subagent-authorization-event`: re-emits the
 * event, and after `authorization.required` parks the parent's open turn with
 * `turn.waiting`. The sign-in completes on the asker's own callback while the
 * call keeps running, so the parent's turn neither ends nor resets.
 */
export async function emitProxiedAuthorizationEvent(input: {
  readonly emit: HarnessEmitFn;
  readonly hookPayload: SubagentAuthorizationEventHookPayload;
  readonly session: HarnessSession;
}): Promise<void> {
  await input.emit(input.hookPayload.event);
  if (input.hookPayload.event.type === "authorization.required") {
    await emitTurnWaiting(input.emit, input.session);
  }
}

async function emitTurnWaiting(emit: HarnessEmitFn, session: HarnessSession): Promise<void> {
  const turn = getHarnessEmissionState(session.state);
  await emit(createTurnWaitingEvent({ sequence: turn.sequence, turnId: turn.turnId }));
}

// ---------------------------------------------------------------------------
// Downward deliver routing
// ---------------------------------------------------------------------------

/** One proxied-child bucket of a routed deliver payload. */
export interface RoutedChildDelivery {
  readonly workflowAsk?: WorkflowAskRoute;
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  readonly payload: { readonly inputResponses: readonly InputResponse[] };
  /** What forwarding this bucket resolves on the routing session. */
  readonly resolved: ProxiedInputResolutions;
}

/**
 * The parent-visible requests one forwarded bucket resolves: those it answers,
 * plus the rest of a batch those answers complete. Each retires from the proxy
 * map, and the session announces them with one `input.resolved` at `event`,
 * the coordinates of the child batch's `input.requested`.
 */
export interface ProxiedInputResolutions {
  readonly event: PendingInputBatchEvent;
  readonly resolutions: readonly InputResolution[];
}

/**
 * Outcome of splitting one deliver payload by the session's proxy map.
 * `forSelf` is the parent-local remainder (or `undefined` when fully
 * routed); `forChildren` carries one entry per descendant token.
 */
export interface RoutedDeliverPayload {
  readonly forChildren: readonly RoutedChildDelivery[];
  readonly forSelf: DeliverPayload | undefined;
  readonly parentAction: { readonly kind: "cancel-turn" } | undefined;
}

/** In-progress accumulation for one `forChildren` bucket. */
interface ChildResponseBucket {
  readonly workflowAsk?: WorkflowAskRoute;
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  /** A child's routes all come from its latest batch, so they share coordinates. */
  readonly event: PendingInputBatchEvent;
  /** Parent-visible request IDs answered in this bucket. */
  readonly parentRequestIds: string[];
  readonly responses: InputResponse[];
  readonly routes: ProxyInputRequest[];
}

/**
 * Splits a deliver payload into parent-local and proxied-child buckets.
 *
 * With `resolveMessage`, a plain-text message is also resolved against pending
 * `ctx.ask()` questions: when exactly one question is pending, a matching option or
 * permitted free text answers it and consumes the message. Otherwise the
 * message stays with the parent.
 */
export function routeDeliverPayload(input: {
  readonly allowRoute?: (requestId: string, route: ProxyInputRequest) => boolean;
  readonly payload: DeliverPayload;
  readonly resolveMessage?: boolean;
  readonly state: SessionStateMap | undefined;
}): RoutedDeliverPayload {
  const entries = getProxyInputRequests(input.state);
  const routable = (requestId: string, route: ProxyInputRequest | undefined) =>
    route !== undefined && input.allowRoute?.(requestId, route) !== false;
  const message = resolveMessageAgainstQuestions({
    enabled: input.resolveMessage === true,
    entries,
    payload: input.payload,
    routable,
  });
  const inputResponses = [...(input.payload.inputResponses ?? []), ...message.responses];

  const responsesByChild = new Map<string, ChildResponseBucket>();
  const unroutedResponses: InputResponse[] = [];
  let parentAction: RoutedDeliverPayload["parentAction"];

  const bucketFor = (route: ProxyInputRequest): ChildResponseBucket => {
    const bucketKey = [route.childContinuationToken, route.childSessionInbox?.sessionId ?? ""].join(
      "\0",
    );
    const existing = responsesByChild.get(bucketKey);
    if (existing !== undefined) return existing;
    const bucket: ChildResponseBucket = {
      childContinuationToken: route.childContinuationToken,
      event: route.event,
      parentRequestIds: [],
      responses: [],
      routes: [],
      ...(route.childSessionInbox !== undefined && {
        childSessionInbox: route.childSessionInbox,
      }),
      ...(route.workflowAsk !== undefined && { workflowAsk: route.workflowAsk }),
    };
    responsesByChild.set(bucketKey, bucket);
    return bucket;
  };

  const routedRequestIds = new Set<string>();
  for (const response of inputResponses) {
    const route = entries.get(response.requestId);

    if (route === undefined || !routable(response.requestId, route)) {
      unroutedResponses.push(response);
      continue;
    }
    // A request takes one answer; the first one in the payload wins.
    if (routedRequestIds.has(response.requestId)) continue;
    routedRequestIds.add(response.requestId);

    if (route.kind === "session-limit" && response.optionId === SESSION_LIMIT_STOP_OPTION_ID) {
      parentAction = { kind: "cancel-turn" };
    }

    const bucket = bucketFor(route);
    bucket.parentRequestIds.push(response.requestId);
    bucket.responses.push(response);
    bucket.routes.push(route);
  }

  const forChildren = [...responsesByChild.values()].map(
    ({
      workflowAsk,
      childContinuationToken,
      childSessionInbox,
      event,
      parentRequestIds,
      responses,
      routes,
    }): RoutedChildDelivery => {
      const responseIds = new Set(parentRequestIds);
      const retireRequestIds = new Set(responseIds);

      // A fully-answered approval batch retires its sibling requests
      // too, so a late free-form answer cannot route through a stale
      // sibling entry after the batch already resolved.
      for (const route of routes) {
        if (
          route.batch !== undefined &&
          batchResolves({ batch: route.batch, childContinuationToken, entries, responseIds })
        ) {
          for (const requestId of route.batch.requestIds) retireRequestIds.add(requestId);
        }
      }

      return {
        childContinuationToken,
        payload: { inputResponses: responses },
        resolved: {
          event,
          resolutions: resolveRetiredRequests({ entries, responses, retireRequestIds }),
        },
        ...(childSessionInbox !== undefined && { childSessionInbox }),
        ...(workflowAsk !== undefined && { workflowAsk }),
      };
    },
  );

  // Preserve every non-`inputResponses` field on the original payload
  // and restore un-routed responses. `undefined` when the resulting
  // payload has no actionable signal.
  const remainder: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input.payload)) {
    if (key === "inputResponses" || value === undefined) {
      continue;
    }
    if (key === "message" && message.consumed) continue;

    remainder[key] = value;
  }

  if (unroutedResponses.length > 0) {
    remainder.inputResponses = unroutedResponses;
  }

  const forSelf = Object.keys(remainder).length > 0 ? (remainder as DeliverPayload) : undefined;

  return { forChildren, forSelf, parentAction };
}

function resolveRetiredRequests(input: {
  readonly entries: ReadonlyMap<string, ProxyInputRequest>;
  readonly responses: readonly InputResponse[];
  readonly retireRequestIds: ReadonlySet<string>;
}): InputResolution[] {
  const responses = new Map(input.responses.map((response) => [response.requestId, response]));
  const resolutions: InputResolution[] = [];
  for (const requestId of input.retireRequestIds) {
    const route = input.entries.get(requestId);
    if (route === undefined) continue;
    resolutions.push(toInputResolution(requestId, route, responses.get(requestId)));
  }
  return resolutions;
}

function toInputResolution(
  requestId: string,
  route: ProxyInputRequest,
  response: InputResponse | undefined,
): InputResolution {
  const outcome = resolveInputOutcome(route.kind, response);
  const resolution: InputResolution = { kind: route.kind, outcome, requestId };
  return response === undefined ? resolution : { ...resolution, response };
}

function resolveMessageAgainstQuestions(input: {
  readonly enabled: boolean;
  readonly entries: ReadonlyMap<string, ProxyInputRequest>;
  readonly payload: DeliverPayload;
  readonly routable: (requestId: string, route: ProxyInputRequest) => boolean;
}): {
  readonly consumed: boolean;
  readonly responses: readonly InputResponse[];
} {
  const none = { consumed: false, responses: [] };
  // An explicit structured answer means the client already chose what to answer.
  if (!input.enabled || (input.payload.inputResponses?.length ?? 0) > 0) return none;
  if (input.payload.message === undefined) return none;

  // Task and subagent questions carry no `ctx.ask()` metadata, so plain text
  // cannot resolve them, but they still make the message ambiguous.
  const pending = [...input.entries].filter(
    ([requestId, route]) => route.kind === "question" && input.routable(requestId, route),
  );
  const questions = pending.flatMap(([requestId, route]) => {
    const question = route.workflowAsk?.question ?? route.question;
    return question !== undefined ? [{ requestId, ...question }] : [];
  });
  if (questions.length === 0) return none;

  const [only] = questions;
  const answer =
    pending.length === 1 && only !== undefined && typeof input.payload.message === "string"
      ? resolveTextToResponse(input.payload.message, only)
      : undefined;
  if (answer !== undefined) return { consumed: true, responses: [answer] };
  return none;
}

function batchResolves(input: {
  readonly batch: NonNullable<ProxyInputRequest["batch"]>;
  readonly childContinuationToken: string;
  readonly entries: ReadonlyMap<string, ProxyInputRequest>;
  readonly responseIds: ReadonlySet<string>;
}): boolean {
  if (input.batch.approvalRequestIds.length === 0) return true;

  return input.batch.approvalRequestIds.every((requestId) => {
    const route = input.entries.get(requestId);
    if (route === undefined || !sameBatch(route, input)) return true;
    return input.responseIds.has(requestId);
  });
}

function sameBatch(
  route: ProxyInputRequest,
  input: {
    readonly batch: NonNullable<ProxyInputRequest["batch"]>;
    readonly childContinuationToken: string;
  },
): boolean {
  return (
    route.childContinuationToken === input.childContinuationToken &&
    route.batch?.requestIds.length === input.batch.requestIds.length &&
    route.batch.requestIds.every((requestId, index) => requestId === input.batch.requestIds[index])
  );
}
