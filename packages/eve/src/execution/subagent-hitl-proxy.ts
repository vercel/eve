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
import type { ProxyInputRequest } from "#harness/proxy-input-requests.js";
import type { HarnessEmitFn, HarnessSession, SessionStateMap } from "#harness/types.js";
import { createInputRequestedEvent } from "#protocol/message.js";
import type { RunMode } from "#shared/run-mode.js";
import type { InputResponse } from "#runtime/input/types.js";
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
  readonly childContinuationToken: string;
  readonly childResponseUrl?: string;
  readonly payload: { readonly inputResponses: readonly InputResponse[] };
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
  readonly childContinuationToken: string;
  readonly childResponseUrl?: string;
  readonly responses: InputResponse[];
  readonly taskId?: string;
}

/** Splits a deliver payload into parent-local and proxied-child buckets. */
export function routeDeliverPayload(input: {
  readonly allowRoute?: (requestId: string, route: ProxyInputRequest) => boolean;
  readonly payload: DeliverPayload;
  readonly state: SessionStateMap | undefined;
}): RoutedDeliverPayload {
  const entries = getProxyInputRequests(input.state);
  const inputResponses = input.payload.inputResponses ?? [];

  const responsesByChild = new Map<string, ChildResponseBucket>();
  const unroutedResponses: InputResponse[] = [];
  let parentAction: RoutedDeliverPayload["parentAction"];

  for (const response of inputResponses) {
    const route = entries.get(response.requestId);

    if (route === undefined || input.allowRoute?.(response.requestId, route) === false) {
      unroutedResponses.push(response);
      continue;
    }

    if (route.kind === "session-limit" && response.optionId === SESSION_LIMIT_STOP_OPTION_ID) {
      parentAction = { kind: "cancel-turn" };
    }

    const bucketKey =
      route.taskId === undefined
        ? route.childContinuationToken
        : `${route.childContinuationToken}\0${route.childResponseUrl ?? "local"}\0${route.taskId}`;
    const existing = responsesByChild.get(bucketKey);

    if (existing === undefined) {
      responsesByChild.set(bucketKey, {
        childContinuationToken: route.childContinuationToken,
        responses: [toChildInputResponse(response, route)],
        ...(route.childResponseUrl !== undefined && { childResponseUrl: route.childResponseUrl }),
        ...(route.taskId !== undefined && { taskId: route.taskId }),
      });
    } else {
      existing.responses.push(toChildInputResponse(response, route));
    }
  }

  const forChildren = [...responsesByChild.values()].map(
    ({ childContinuationToken, childResponseUrl, responses, taskId }): RoutedChildDelivery => ({
      childContinuationToken,
      payload: { inputResponses: responses },
      ...(childResponseUrl !== undefined && { childResponseUrl }),
      ...(taskId !== undefined && { taskId }),
    }),
  );

  // Preserve every non-`inputResponses` field on the original payload
  // and restore un-routed responses. `undefined` when the resulting
  // payload has no actionable signal.
  const remainder: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input.payload)) {
    if (key === "inputResponses" || value === undefined) {
      continue;
    }

    remainder[key] = value;
  }

  if (unroutedResponses.length > 0) {
    remainder.inputResponses = unroutedResponses;
  }

  const forSelf = Object.keys(remainder).length > 0 ? (remainder as DeliverPayload) : undefined;

  return { forChildren, forSelf, parentAction };
}

function toChildInputResponse(response: InputResponse, route: ProxyInputRequest): InputResponse {
  return route.childRequestId === undefined
    ? response
    : { ...response, requestId: route.childRequestId };
}
