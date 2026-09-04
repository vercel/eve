import type { DeliverPayload } from "#channel/types.js";
import { getProxyInputRequests, proxyInputRouteKey } from "#harness/proxy-input-requests.js";
import type { InboxResponseRoute, ProxyInputRequest } from "#harness/proxy-input-requests.js";
import type { SessionStateMap } from "#harness/types.js";
import type { InputResponse } from "#shared/input.js";
import { SESSION_LIMIT_STOP_OPTION_ID } from "#harness/session-limit-continuation.js";

/** One proxied-child bucket of a routed deliver payload. */
export interface RoutedChildDelivery {
  readonly inboxResponse?: InboxResponseRoute;
  readonly childContinuationToken: string;
  readonly childResponseUrl?: string;
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
  readonly inboxResponse?: InboxResponseRoute;
  readonly childContinuationToken: string;
  readonly childResponseUrl?: string;
  /** Parent-visible request IDs answered in this bucket. */
  readonly parentRequestIds: string[];
  readonly responses: InputResponse[];
  readonly routes: ProxyInputRequest[];
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

    const bucketKey = proxyInputRouteKey(route);
    const existing = responsesByChild.get(bucketKey);

    if (existing === undefined) {
      responsesByChild.set(bucketKey, {
        childContinuationToken: route.childContinuationToken,
        parentRequestIds: [response.requestId],
        responses: [toChildInputResponse(response, route)],
        routes: [route],
        ...(route.inboxResponse !== undefined && { inboxResponse: route.inboxResponse }),
        ...(route.childResponseUrl !== undefined && { childResponseUrl: route.childResponseUrl }),
        ...(route.taskId !== undefined && { taskId: route.taskId }),
      });
    } else {
      existing.parentRequestIds.push(response.requestId);
      existing.responses.push(toChildInputResponse(response, route));
      existing.routes.push(route);
    }
  }

  const forChildren = [...responsesByChild.values()].map(
    ({
      inboxResponse,
      childContinuationToken,
      childResponseUrl,
      parentRequestIds,
      responses,
      routes,
      taskId,
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
        retireRequestIds: [...retireRequestIds],
        ...(inboxResponse !== undefined && { inboxResponse }),
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

    remainder[key] = value;
  }

  if (unroutedResponses.length > 0) {
    remainder.inputResponses = unroutedResponses;
  }

  const forSelf = Object.keys(remainder).length > 0 ? (remainder as DeliverPayload) : undefined;

  return { forChildren, forSelf, parentAction };
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
