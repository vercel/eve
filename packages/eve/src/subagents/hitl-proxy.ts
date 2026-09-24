import type { SessionInboxAddress } from "#execution/session-inbox/address.js";
import type { DeliverPayload, SubagentInputRequestHookPayload } from "#channel/types.js";
import {
  emitTurnEpilogue,
  getHarnessEmissionState,
  setHarnessEmissionState,
} from "#harness/emission.js";
import {
  getProxyInputRequests,
  toProxyInputRequestEntries,
} from "#harness/proxy-input-requests.js";
import type { AnswerHookRoute, ProxyInputRequest } from "#harness/proxy-input-requests.js";
import type { HarnessEmitFn, HarnessSession, SessionStateMap } from "#harness/types.js";
import { createInputRequestedEvent } from "#protocol/message.js";
import type { RunMode } from "#shared/run-mode.js";
import type { InputResponse } from "#shared/input.js";
import { resolveTextToResponse } from "#channel/resolve-text.js";
import { SESSION_LIMIT_STOP_OPTION_ID } from "#harness/session-limit-continuation.js";

// ---------------------------------------------------------------------------
// Upward proxy emission
// ---------------------------------------------------------------------------

/**
 * Runs the parent-side work for a `subagent-input-request`. Conversation
 * mode emits a waiting boundary on the parent stream; the returned proxy
 * entries route the eventual response back down to the child.
 */
export async function emitProxiedInputRequest(input: {
  readonly emit: HarnessEmitFn;
  readonly hookPayload: SubagentInputRequestHookPayload;
  readonly mode: RunMode;
  readonly session: HarnessSession;
}): Promise<{
  readonly entries: readonly (readonly [requestId: string, route: ProxyInputRequest])[];
  readonly session: HarnessSession;
}> {
  await input.emit(
    createInputRequestedEvent({
      requests: input.hookPayload.event.requests,
      sequence: input.hookPayload.event.sequence,
      stepIndex: input.hookPayload.event.stepIndex,
      turnId: input.hookPayload.event.turnId,
    }),
  );

  let nextSession = input.session;

  if (input.mode === "conversation") {
    const state = getHarnessEmissionState(input.session.state);
    const nextState = await emitTurnEpilogue(input.emit, state, input.mode);
    nextSession = setHarnessEmissionState(input.session, nextState);
  }

  return {
    entries: toProxyInputRequestEntries(input.hookPayload),
    session: nextSession,
  };
}

// ---------------------------------------------------------------------------
// Downward deliver routing
// ---------------------------------------------------------------------------

/** One proxied-child bucket of a routed deliver payload. */
export interface RoutedChildDelivery {
  readonly answerHook?: AnswerHookRoute;
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  readonly childResponseUrl?: string;
  /** Answer-hook requests the user moved past; each hook resumes as `dismissed`. */
  readonly dismissedRequestIds?: readonly string[];
  readonly payload: { readonly inputResponses: readonly InputResponse[] };
  /** Parent-visible request IDs safe to retire once this bucket is forwarded. */
  readonly retireRequestIds: readonly string[];
  /** Present when the child is owned by a task run, which delivers on the parent's behalf. */
  readonly taskId?: string;
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
  readonly answerHook?: AnswerHookRoute;
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  readonly childResponseUrl?: string;
  readonly dismissedRequestIds: string[];
  /** Parent-visible request IDs answered in this bucket. */
  readonly parentRequestIds: string[];
  readonly responses: InputResponse[];
  readonly routes: ProxyInputRequest[];
  readonly taskId?: string;
}

/**
 * Splits a deliver payload into parent-local and proxied-child buckets.
 *
 * With `resolveMessage`, a plain-text message is also resolved against pending
 * `ctx.ask()` questions: when exactly one question is pending, a matching option or
 * permitted free text answers it and consumes the message. Otherwise the
 * message dismisses every `dismissible` question and stays with the parent.
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
    const bucketKey = [
      route.childContinuationToken,
      route.childSessionInbox?.sessionId ?? "",
      route.childResponseUrl ?? "local",
      route.taskId ?? "",
    ].join("\0");
    const existing = responsesByChild.get(bucketKey);
    if (existing !== undefined) return existing;
    const bucket: ChildResponseBucket = {
      childContinuationToken: route.childContinuationToken,
      dismissedRequestIds: [],
      parentRequestIds: [],
      responses: [],
      routes: [],
      ...(route.childSessionInbox !== undefined && {
        childSessionInbox: route.childSessionInbox,
      }),
      ...(route.answerHook !== undefined && { answerHook: route.answerHook }),
      ...(route.childResponseUrl !== undefined && { childResponseUrl: route.childResponseUrl }),
      ...(route.taskId !== undefined && { taskId: route.taskId }),
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
    bucket.responses.push(toChildInputResponse(response, route));
    bucket.routes.push(route);
  }

  for (const requestId of message.dismissedRequestIds) {
    const route = entries.get(requestId);
    if (route !== undefined) bucketFor(route).dismissedRequestIds.push(requestId);
  }

  const forChildren = [...responsesByChild.values()].map(
    ({
      answerHook,
      childContinuationToken,
      childSessionInbox,
      childResponseUrl,
      dismissedRequestIds,
      parentRequestIds,
      responses,
      routes,
      taskId,
    }): RoutedChildDelivery => {
      const responseIds = new Set(parentRequestIds);
      const retireRequestIds = new Set([...responseIds, ...dismissedRequestIds]);

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
        retireRequestIds: [...retireRequestIds],
        ...(dismissedRequestIds.length > 0 && { dismissedRequestIds }),
        ...(childSessionInbox !== undefined && { childSessionInbox }),
        ...(answerHook !== undefined && { answerHook }),
        ...(childResponseUrl !== undefined && { childResponseUrl }),
        ...(taskId !== undefined && { taskId }),
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

function resolveMessageAgainstQuestions(input: {
  readonly enabled: boolean;
  readonly entries: ReadonlyMap<string, ProxyInputRequest>;
  readonly payload: DeliverPayload;
  readonly routable: (requestId: string, route: ProxyInputRequest) => boolean;
}): {
  readonly consumed: boolean;
  readonly dismissedRequestIds: readonly string[];
  readonly responses: readonly InputResponse[];
} {
  const none = { consumed: false, dismissedRequestIds: [], responses: [] };
  // An explicit structured answer means the client already chose what to answer.
  if (!input.enabled || (input.payload.inputResponses?.length ?? 0) > 0) return none;
  if (input.payload.message === undefined) return none;

  // Task and subagent questions carry no answer-hook metadata, so plain text
  // cannot resolve them, but they still make the message ambiguous.
  const pending = [...input.entries].filter(
    ([requestId, route]) => route.kind === "question" && input.routable(requestId, route),
  );
  const questions = pending.flatMap(([requestId, route]) => {
    const question = route.answerHook?.question ?? route.question;
    return question !== undefined ? [{ requestId, ...question }] : [];
  });
  if (questions.length === 0) return none;

  const [only] = questions;
  const answer =
    pending.length === 1 && only !== undefined && typeof input.payload.message === "string"
      ? resolveTextToResponse(input.payload.message, only)
      : undefined;
  if (answer !== undefined) return { consumed: true, dismissedRequestIds: [], responses: [answer] };

  return {
    consumed: false,
    dismissedRequestIds: questions
      .filter((question) => question.dismissible === true)
      .map((question) => question.requestId),
    responses: [],
  };
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

function toChildInputResponse(response: InputResponse, route: ProxyInputRequest): InputResponse {
  return route.childRequestId === undefined
    ? response
    : { ...response, requestId: route.childRequestId };
}
