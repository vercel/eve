import type { SessionInboxAddress } from "#execution/session-inbox/address.js";
import { hasDelegatedSessionContext } from "#execution/delegated-session-context.js";
import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import {
  type DurableSessionState,
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import { relaySessionEvents, type SessionStepState } from "#execution/publish-session-events.js";
import { routeDeliverPayload } from "#subagents/hitl-proxy.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import {
  sendWorkflowAskAnswers,
  toToolInputResponseResponder,
} from "#execution/tools/workflow/answer.js";
import type { PendingInputBatchEvent } from "#harness/pending-input-batches.js";
import type { WorkflowAskRoute } from "#harness/proxy-input-requests.js";
import {
  createInputResolvedEvent,
  type InputResolution,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { retireProxyInputRequests } from "#harness/proxy-input-requests.js";

export type RoutedDeliverResult =
  | {
      readonly kind: "cancel-turn";
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly kind: "continue";
      readonly remainder: DeliverHookPayload | undefined;
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    };

interface ChildBucket {
  readonly workflowAsk?: WorkflowAskRoute;
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  readonly event: PendingInputBatchEvent;
  readonly metadata: NonNullable<DeliverHookPayload["deliveryMetadata"]>[number][];
  readonly payloads: DeliverPayload[];
  /** Keyed by request id: a request resolves once however many payloads answer it. */
  readonly resolutions: Map<string, InputResolution>;
}

/**
 * Splits an envelope and forwards descendant input to the child that asked for
 * it. This session relayed each forwarded request's `input.requested`, so it
 * also relays their `input.resolved` once the answers are on their way down.
 */
export async function routeProxiedDeliverStep(
  input: SessionStepState & { readonly delivery: DeliverHookPayload },
): Promise<RoutedDeliverResult> {
  "use step";
  let durableSession = readDurableSession(input.sessionState);
  const sourceDelivery = input.delivery;
  const parentPayloads = new Map<number, DeliverPayload>();
  const children = new Map<string, ChildBucket>();
  let parentAction: { readonly kind: "cancel-turn" } | undefined;
  // Only a person's own message may answer or skip a pending question.
  const resolveMessage =
    !hasDelegatedSessionContext(input.serializedContext) && sourceDelivery.caller === undefined;
  // Every payload routes against the same state, so a `ctx.ask()` question
  // resolved by an earlier payload is hidden from later ones; its run takes
  // one answer, and later messages must reach the parent instead.
  const resolvedQuestions = new Set<string>();

  for (const [sourcePayloadIndex, payload] of sourceDelivery.payloads.entries()) {
    const routed = routeDeliverPayload({
      allowRoute: (requestId) => !resolvedQuestions.has(requestId),
      payload,
      resolveMessage,
      state: durableSession.state,
    });
    parentAction ??= routed.parentAction;
    if (routed.forSelf !== undefined) parentPayloads.set(sourcePayloadIndex, routed.forSelf);

    for (const [childIndex, forChild] of routed.forChildren.entries()) {
      if (forChild.workflowAsk !== undefined) {
        for (const { requestId } of forChild.resolved.resolutions) resolvedQuestions.add(requestId);
      }
      const key = [
        forChild.childContinuationToken,
        forChild.childSessionInbox?.sessionId ?? "",
      ].join("\0");
      const child: ChildBucket = children.get(key) ?? {
        workflowAsk: forChild.workflowAsk,
        childContinuationToken: forChild.childContinuationToken,
        childSessionInbox: forChild.childSessionInbox,
        event: forChild.resolved.event,
        metadata: [],
        payloads: [],
        resolutions: new Map(),
      };
      const childPayloadIndex = child.payloads.length;
      child.payloads.push(forChild.payload);
      for (const resolution of forChild.resolved.resolutions) {
        if (!child.resolutions.has(resolution.requestId)) {
          child.resolutions.set(resolution.requestId, resolution);
        }
      }
      if (routed.forSelf === undefined && childIndex === 0) {
        for (const metadata of sourceDelivery.deliveryMetadata ?? []) {
          if (metadata.payloadIndex === sourcePayloadIndex) {
            child.metadata.push({ ...metadata, payloadIndex: childPayloadIndex });
          }
        }
      }
      children.set(key, child);
    }
  }

  let retired = false;
  const resolvedEvents: UnstampedMessageStreamEvent[] = [];
  for (const child of children.values()) {
    if (child.workflowAsk !== undefined) {
      const responses = coalesceDeliverPayloads(child.payloads).inputResponses ?? [];
      await sendWorkflowAskAnswers(
        child.workflowAsk,
        responses,
        toToolInputResponseResponder(sourceDelivery.auth),
      );
    } else {
      const childDelivery: DeliverHookPayload = {
        ...sourceDelivery,
        deliveryMetadata: child.metadata.length === 0 ? undefined : child.metadata,
        payloads: child.payloads,
      };
      await resumeSessionInbox(
        child.childSessionInbox ?? child.childContinuationToken,
        childDelivery,
      );
    }
    if (child.resolutions.size > 0) {
      resolvedEvents.push(
        createInputResolvedEvent({ resolutions: [...child.resolutions.values()], ...child.event }),
      );
    }
    // Successfully forwarded request IDs are retired so later deliveries
    // cannot route through stale entries.
    durableSession = retireProxyInputRequests(durableSession, [...child.resolutions.keys()]);
    retired = true;
  }

  const context = await relaySessionEvents(
    {
      serializedContext: input.serializedContext,
      sessionState: retired
        ? replaceDurableSessionSnapshot({ session: durableSession, state: input.sessionState })
        : input.sessionState,
      sessionWritable: input.sessionWritable,
    },
    resolvedEvents,
  );
  if (parentAction !== undefined) return { ...context, ...parentAction };
  const orderedParentPayloads = [...parentPayloads].sort(([a], [b]) => a - b);
  const parentMetadata = orderedParentPayloads.flatMap(([sourcePayloadIndex], payloadIndex) =>
    (sourceDelivery.deliveryMetadata ?? [])
      .filter((metadata) => metadata.payloadIndex === sourcePayloadIndex)
      .map((metadata) => ({ ...metadata, payloadIndex })),
  );
  const remainder =
    orderedParentPayloads.length === 0
      ? undefined
      : {
          ...sourceDelivery,
          deliveryMetadata: parentMetadata.length === 0 ? undefined : parentMetadata,
          payloads: orderedParentPayloads.map(([, payload]) => payload),
        };
  return { ...context, kind: "continue", remainder };
}
