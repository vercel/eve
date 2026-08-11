import type { DeliverPayload, SubagentInputRequestHookPayload } from "#channel/types.js";
import { resolveTextToResponse } from "#channel/resolve-text.js";
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

/**
 * Outcome of splitting one deliver payload by the session's proxy map.
 * `forSelf` is the parent-local remainder (or `undefined` when fully
 * routed); `forChildren` carries one entry per descendant token.
 */
export interface RoutedDeliverPayload {
  readonly forChildren: readonly {
    readonly childContinuationToken: string;
    readonly payload: { readonly inputResponses: readonly InputResponse[] };
  }[];
  readonly forSelf: DeliverPayload | undefined;
  readonly parentAction: { readonly kind: "cancel-turn" } | undefined;
}

/** Splits a deliver payload into parent-local and proxied-child buckets. */
export function routeDeliverPayload(input: {
  readonly payload: DeliverPayload;
  readonly state: SessionStateMap | undefined;
}): RoutedDeliverPayload {
  const entries = getProxyInputRequests(input.state);
  const inputResponses = [...(input.payload.inputResponses ?? [])];
  let resolvedTextMessage = false;

  if (typeof input.payload.message === "string") {
    const answeredRequestIds = new Set(inputResponses.map((response) => response.requestId));
    for (const [requestId, route] of entries) {
      if (
        route.answered === true ||
        route.request === undefined ||
        answeredRequestIds.has(requestId)
      ) {
        continue;
      }
      const response = resolveTextToResponse(input.payload.message, route.request);
      if (response !== undefined) {
        inputResponses.push(response);
        answeredRequestIds.add(requestId);
        resolvedTextMessage = true;
      }
    }
  }

  const responsesByChild = new Map<string, InputResponse[]>();
  const unroutedResponses: InputResponse[] = [];
  let parentAction: RoutedDeliverPayload["parentAction"];

  for (const response of inputResponses) {
    const route = entries.get(response.requestId);

    if (route === undefined || route.answered === true) {
      unroutedResponses.push(response);
      continue;
    }

    if (route.kind === "session-limit" && response.optionId === SESSION_LIMIT_STOP_OPTION_ID) {
      parentAction = { kind: "cancel-turn" };
    }

    const existing = responsesByChild.get(route.childContinuationToken);

    if (existing === undefined) {
      responsesByChild.set(route.childContinuationToken, [response]);
    } else {
      existing.push(response);
    }
  }

  const forChildren: RoutedDeliverPayload["forChildren"] = [...responsesByChild.entries()].map(
    ([childContinuationToken, responses]) => ({
      childContinuationToken,
      payload: { inputResponses: responses },
    }),
  );

  // Preserve every non-`inputResponses` field on the original payload
  // and restore un-routed responses. `undefined` when the resulting
  // payload has no actionable signal.
  const remainder: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input.payload)) {
    if (
      key === "inputResponses" ||
      (key === "message" && resolvedTextMessage) ||
      value === undefined
    ) {
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
