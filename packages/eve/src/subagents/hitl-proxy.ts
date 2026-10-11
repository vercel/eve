import type { SessionInboxAddress } from "#execution/session-inbox/address.js";
import type { DeliverPayload } from "#channel/types.js";
import { resolveInputOutcome } from "#harness/input-request-resolution.js";
import { firstOpenInput } from "#harness/open-input-request.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { StepCoordinates as PendingInputBatchEvent } from "#harness/session-machine/view.js";
import { getProxyInputRequests, resolvedByChild } from "#harness/proxy-input-requests.js";
import type { WorkflowAskRoute, ProxyInputRequest } from "#harness/proxy-input-requests.js";
import type { SessionStateMap } from "#harness/types.js";
import type { InputResolution } from "#protocol/message.js";
import type { InputResponse } from "#shared/input.js";
import { resolveTextToResponse } from "#channel/resolve-text.js";
import { inputTextKey, readAnswerText } from "#internal/input-text.js";
import { SESSION_LIMIT_STOP_OPTION_ID } from "#harness/hitl/budget-request.js";

// ---------------------------------------------------------------------------
// Downward deliver routing
// ---------------------------------------------------------------------------

/** One proxied-child bucket of a routed deliver payload. */
export interface RoutedChildDelivery {
  readonly workflowAsk?: WorkflowAskRoute;
  readonly remote?: ProxyInputRequest["remote"];
  readonly inputSource?: string;
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  /** The person's message whose text answered this bucket's question. */
  readonly message?: DeliverPayload["message"];
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
  readonly remote?: ProxyInputRequest["remote"];
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  /** A child's routes all come from its latest batch, so they share coordinates. */
  readonly event: PendingInputBatchEvent;
  /** Parent-visible request IDs answered in this bucket. */
  readonly parentRequestIds: string[];
  readonly responses: InputResponse[];
  readonly routes: ProxyInputRequest[];
}

/** Payload keys that describe the message, dropped with it when it answers a question. */
const CONSUMED_MESSAGE_KEYS: ReadonlySet<string> = new Set(["context", "message", inputTextKey]);

/**
 * Splits a deliver payload into parent-local and proxied-child buckets.
 *
 * With `resolveMessage`, a plain-text message is also resolved against the
 * first open request when a child asked it, whether a `ctx.ask()` question, a
 * tool approval, or a session-limit prompt: a matching option or permitted free
 * text answers that one request, and the message is consumed along with its
 * `context`. Otherwise the message stays with the parent.
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
  const message = resolveMessageAgainstFirstRequest({
    enabled: input.resolveMessage === true,
    entries,
    payload: input.payload,
    routable,
    state: input.state,
  });
  const [textAnswer] = message.responses;
  const inputResponses = [...(input.payload.inputResponses ?? []), ...message.responses];

  const responsesByChild = new Map<string, ChildResponseBucket>();
  const unroutedResponses: InputResponse[] = [];
  let parentAction: RoutedDeliverPayload["parentAction"];

  const bucketFor = (route: ProxyInputRequest): ChildResponseBucket => {
    const bucketKey = JSON.stringify([
      route.childContinuationToken,
      route.childSessionInbox?.sessionId ?? "",
      route.remote?.sessionId ?? "",
      route.event.sequence,
      route.event.stepIndex,
      route.event.turnId,
      route.inputSource ?? null,
    ]);
    const existing = responsesByChild.get(bucketKey);
    if (existing !== undefined) return existing;
    const bucket: ChildResponseBucket = {
      childContinuationToken: route.childContinuationToken,
      remote: route.remote,
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
      remote,
      childContinuationToken,
      childSessionInbox,
      event,
      parentRequestIds,
      responses,
      routes,
    }): RoutedChildDelivery => {
      const responseIds = new Set(parentRequestIds);
      const decided = (requestId: string) => {
        const kind = entries.get(requestId)?.kind;
        return kind === undefined || !resolvedByChild(kind);
      };
      const retireRequestIds = new Set([...responseIds].filter(decided));

      // A fully-answered approval batch retires its sibling requests
      // too, so a late free-form answer cannot route through a stale
      // sibling entry after the batch already resolved.
      for (const route of routes) {
        if (
          route.batch !== undefined &&
          batchResolves({ batch: route.batch, childContinuationToken, entries, responseIds })
        ) {
          for (const requestId of route.batch.requestIds) {
            if (decided(requestId)) retireRequestIds.add(requestId);
          }
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
        ...(textAnswer !== undefined &&
          responses.includes(textAnswer) && { message: input.payload.message }),
        ...(workflowAsk !== undefined && { workflowAsk }),
        ...(remote !== undefined && { remote }),
        ...(routes[0]?.inputSource !== undefined && { inputSource: routes[0].inputSource }),
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
    // Channels attach per-message context, such as Telegram's sender block. Kept
    // without its message, it would reach the model as a message of its own.
    if (message.consumed && CONSUMED_MESSAGE_KEYS.has(key)) continue;

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

function resolveMessageAgainstFirstRequest(input: {
  readonly enabled: boolean;
  readonly entries: ReadonlyMap<string, ProxyInputRequest>;
  readonly payload: DeliverPayload;
  readonly routable: (requestId: string, route: ProxyInputRequest) => boolean;
  readonly state: SessionStateMap | undefined;
}): {
  readonly consumed: boolean;
  readonly responses: readonly InputResponse[];
} {
  const none = { consumed: false, responses: [] };
  // An explicit structured answer means the client already chose what to answer.
  if (!input.enabled || (input.payload.inputResponses?.length ?? 0) > 0) return none;
  const text = readAnswerText(input.payload);
  if (text === undefined) return none;

  // A request an earlier payload answered is no longer open to this one.
  const answered = (id: string) => {
    const route = input.entries.get(id);
    return route !== undefined && !input.routable(id, route);
  };
  // A relay the session recorded without publishing it falls back to the order it was recorded.
  const requestId =
    firstOpenInput(storedProjection(input.state), answered)?.request.requestId ??
    [...input.entries.keys()].find((id) => !answered(id));
  const reply = requestId === undefined ? undefined : input.entries.get(requestId)?.reply;
  // A request recorded without reply metadata cannot be matched at all.
  if (requestId === undefined || reply === undefined) return none;
  const answer = resolveTextToResponse(text, { requestId, ...reply });
  return answer === undefined ? none : { consumed: true, responses: [answer] };
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
