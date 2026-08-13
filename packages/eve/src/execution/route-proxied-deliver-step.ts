import type { DeliverHookPayload, DeliverPayload, SessionAuthContext } from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import {
  type DurableSessionState,
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import { routeDeliverPayload } from "#execution/subagent-hitl-proxy.js";
import { retireProxyInputRequests } from "#harness/proxy-input-requests.js";
import { resumeHook } from "#internal/workflow/runtime.js";

export type RoutedDeliverResult =
  | { readonly kind: "cancel-turn"; readonly sessionState: DurableSessionState }
  | {
      readonly kind: "continue";
      readonly remainder: DeliverHookPayload | undefined;
      readonly sessionState: DurableSessionState;
    };

type LegacyRoutedDeliverResult =
  | { readonly kind: "cancel-turn"; readonly sessionState: DurableSessionState }
  | {
      readonly kind: "continue";
      readonly remainder: DeliverPayload | undefined;
      readonly sessionState: DurableSessionState;
    };

/**
 * Splits an inbound deliver payload into parent-local and proxied-child buckets.
 * Successfully forwarded request IDs are retired from the returned snapshot.
 */
export function routeProxiedDeliverStep(input: {
  readonly delivery: DeliverHookPayload;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly sessionState: DurableSessionState;
}): Promise<RoutedDeliverResult>;
export function routeProxiedDeliverStep(input: {
  readonly auth?: SessionAuthContext | null;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly payload: DeliverPayload;
  readonly sessionState: DurableSessionState;
}): Promise<LegacyRoutedDeliverResult>;
export async function routeProxiedDeliverStep(
  input:
    | {
        readonly delivery: DeliverHookPayload;
        readonly parentWritable: WritableStream<Uint8Array>;
        readonly sessionState: DurableSessionState;
      }
    | {
        readonly auth?: SessionAuthContext | null;
        readonly parentWritable: WritableStream<Uint8Array>;
        readonly payload: DeliverPayload;
        readonly sessionState: DurableSessionState;
      },
): Promise<LegacyRoutedDeliverResult | RoutedDeliverResult> {
  "use step";

  let durableSession = await readDurableSession(input.sessionState);
  const legacyInput = !("delivery" in input);
  const sourceDelivery: DeliverHookPayload =
    "delivery" in input
      ? input.delivery
      : { auth: input.auth, kind: "deliver", payloads: [input.payload] };
  const metadataByPayload = new Map(
    (sourceDelivery.deliveryMetadata ?? []).map((entry) => [entry.payloadIndex, entry]),
  );
  const parentPayloads: DeliverPayload[] = [];
  const parentMetadata: NonNullable<DeliverHookPayload["deliveryMetadata"]>[number][] = [];
  const children = new Map<
    string,
    {
      metadata: NonNullable<DeliverHookPayload["deliveryMetadata"]>[number][];
      payloads: DeliverPayload[];
      retireRequestIds: string[];
    }
  >();
  let parentAction: { readonly kind: "cancel-turn" } | undefined;

  for (const [payloadIndex, payload] of sourceDelivery.payloads.entries()) {
    const routed = routeDeliverPayload({ payload, state: durableSession.state });
    parentAction ??= routed.parentAction;
    const metadata = metadataByPayload.get(payloadIndex);

    if (routed.forSelf !== undefined) {
      const nextIndex = parentPayloads.length;
      parentPayloads.push(routed.forSelf);
      if (metadata !== undefined) parentMetadata.push({ ...metadata, payloadIndex: nextIndex });
    }

    for (const [childIndex, forChild] of routed.forChildren.entries()) {
      const child = children.get(forChild.childContinuationToken) ?? {
        metadata: [],
        payloads: [],
        retireRequestIds: [],
      };
      const nextIndex = child.payloads.length;
      child.payloads.push(forChild.payload);
      child.retireRequestIds.push(...forChild.retireRequestIds);
      if (metadata !== undefined && routed.forSelf === undefined && childIndex === 0) {
        child.metadata.push({ ...metadata, payloadIndex: nextIndex });
      }
      children.set(forChild.childContinuationToken, child);
    }
  }

  for (const [childContinuationToken, child] of children) {
    const delivery: DeliverHookPayload = {
      auth: sourceDelivery.auth,
      caller: sourceDelivery.caller,
      deliveryMetadata: child.metadata.length === 0 ? undefined : child.metadata,
      kind: "deliver",
      payloads: child.payloads,
      requestId: sourceDelivery.requestId,
    };
    await resumeHook(childContinuationToken, {
      ...delivery,
      payload: coalesceDeliverPayloads(child.payloads),
    });
    durableSession = retireProxyInputRequests(durableSession, child.retireRequestIds);
  }

  const sessionState =
    children.size === 0
      ? input.sessionState
      : replaceDurableSessionSnapshot({ session: durableSession, state: input.sessionState });

  if (parentAction !== undefined) return { ...parentAction, sessionState };
  const remainder =
    parentPayloads.length === 0
      ? undefined
      : legacyInput
        ? coalesceDeliverPayloads(parentPayloads)
        : {
            ...sourceDelivery,
            deliveryMetadata: parentMetadata.length === 0 ? undefined : parentMetadata,
            payloads: parentPayloads,
          };
  return { kind: "continue", remainder, sessionState };
}
