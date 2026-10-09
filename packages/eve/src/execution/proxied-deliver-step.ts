import { userPartsOf } from "#harness/user-parts.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { routeAnswer, hold } from "#harness/session-machine/transitions.js";
import { principalOf } from "#execution/session/delivery-facts.js";
import { publicViewOf } from "#harness/session-machine/closure.js";
import { interactionOwner } from "#protocol/session-projection/selectors.js";
import type { ResponseSubmittedData } from "#protocol/session-events/families/response.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { SessionInboxAddress } from "#execution/session-inbox/address.js";
import { hasDelegatedSessionContext } from "#execution/delegated-session-context.js";
import { buildAdapterContext } from "#channel/adapter-context.js";
import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import { AuthKey, TurnDeliveryIdsKey } from "#context/keys.js";
import { setChannelContext } from "#execution/channel-context.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import {
  type DurableSessionState,
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import {
  relaySessionEvents,
  type PublishedSessionEvents,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import {
  resolveRemoteAgentStreamHeaders,
  respondToRemoteAgentSession,
} from "#execution/agent-sessions/remote.js";
import { routeDeliverPayload } from "#subagents/hitl-proxy.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import {
  sendWorkflowAskAnswers,
  toToolInputResponseResponder,
} from "#execution/tools/workflow/answer.js";
import type { StepCoordinates as PendingInputBatchEvent } from "#harness/session-machine/view.js";
import type { WorkflowAskRoute } from "#harness/proxy-input-requests.js";
import { type InputResolution } from "#protocol/message.js";
import { getProxyInputRequests, retireProxyInputRequests } from "#harness/proxy-input-requests.js";
import type { InputResponse } from "#shared/input.js";

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
  readonly remote?: NonNullable<
    import("#harness/proxy-input-requests.js").ProxyInputRequest["remote"]
  >;
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
 * it. This session relayed each forwarded request's `interaction.opened`, so it
 * also relays their `interaction.settled` once the answers are on their way down.
 */
export async function routeProxiedDeliverStep(
  input: SessionStepState & { readonly delivery: DeliverHookPayload },
): Promise<WithSessionStateDelta<RoutedDeliverResult>> {
  "use step";
  return await withSessionStateDelta(input, routeProxiedDeliver);
}

async function routeProxiedDeliver(
  input: SessionStepState & { readonly delivery: DeliverHookPayload },
): Promise<RoutedDeliverResult> {
  const requests = getProxyInputRequests(readDurableSession(input.sessionState).state);
  const { delivery: sourceDelivery, serializedContext } = await deliverChannelInputResponses({
    ...input,
    routable: (response) => requests.has(response.requestId),
  });
  let durableSession = readDurableSession(input.sessionState);
  const parentPayloads = new Map<number, DeliverPayload>();
  const children = new Map<string, ChildBucket>();
  let parentAction: { readonly kind: "cancel-turn" } | undefined;
  // Only a person's own message may answer a pending prompt by text.
  const resolveMessage =
    !hasDelegatedSessionContext(serializedContext) && sourceDelivery.caller === undefined;
  // Every payload routes against the same state, so a request a `ctx.ask()`
  // answer or typed reply resolved in an earlier payload is hidden from later
  // ones; it takes one answer, and later messages must reach the parent instead.
  const resolvedRequests = new Set<string>();
  // A message that answers a question is still the person's turn in the
  // conversation, so the stream records it with its delivery ids.
  const answerDeliveryIds: string[] = [];
  // A delivery that carried only relayed answers is this session's to record: it took effect
  // once forwarded, or, as a message, joins the turn that asked.
  const tables = publicViewOf(storedProjection(durableSession.state));
  const routedDeliveries: Parameters<typeof routeAnswer>[1]["deliveries"][number][] = [];
  const answers: ResponseSubmittedData[] = [];

  for (const [sourcePayloadIndex, payload] of sourceDelivery.payloads.entries()) {
    const routed = routeDeliverPayload({
      allowRoute: (requestId) => !resolvedRequests.has(requestId),
      payload,
      resolveMessage,
      state: durableSession.state,
    });
    parentAction ??= routed.parentAction;
    if (routed.forSelf !== undefined) parentPayloads.set(sourcePayloadIndex, routed.forSelf);
    const payloadMetadata = (sourceDelivery.deliveryMetadata ?? []).filter(
      (metadata) => metadata.payloadIndex === sourcePayloadIndex,
    );
    const answeredBy = payloadMetadata[0]?.deliveryId;
    if (routed.forChildren.length > 0 && answeredBy !== undefined) {
      const message = routed.forChildren.find((forChild) => forChild.message !== undefined);
      const askedIn = message?.payload.inputResponses
        .map((response) => tables.interactions[response.requestId])
        .find((row) => row !== undefined);
      const turnId = askedIn === undefined ? undefined : interactionOwner(tables, askedIn).turnId;
      for (const metadata of payloadMetadata) {
        const entry: {
          -readonly [
            K in keyof (typeof routedDeliveries)[number]
          ]: (typeof routedDeliveries)[number][K];
        } = {
          deliveryId: metadata.deliveryId,
        };
        const principal = principalOf(sourceDelivery.auth);
        if (principal !== undefined) entry.principal = principal;
        if (metadata.channelKind !== undefined) entry.source = { channel: metadata.channelKind };
        // Input left for this session goes on to its turn, which admits nothing twice.
        if (routed.forSelf !== undefined) entry.continues = true;
        else if (message?.message !== undefined && turnId !== undefined)
          entry.consumed = { parts: userPartsOf(message.message), turnId };
        routedDeliveries.push(entry);
      }
      for (const forChild of routed.forChildren) {
        for (const response of forChild.payload.inputResponses) {
          const index = (payload.inputResponses ?? []).indexOf(response);
          const value: { optionId?: string; text?: string } = {};
          if (response.optionId !== undefined) value.optionId = response.optionId;
          if (response.text !== undefined) value.text = response.text;
          answers.push({
            deliveryId: answeredBy,
            interactionId: response.requestId,
            // Named apart from the answers this session's turn admits from the same delivery.
            responseId: `response_${answeredBy}_forwarded_${index === -1 ? `typed_0` : String(index)}`,
            value,
          });
        }
      }
    }

    for (const [childIndex, forChild] of routed.forChildren.entries()) {
      if (forChild.workflowAsk !== undefined || forChild.message !== undefined) {
        for (const { requestId } of forChild.payload.inputResponses)
          resolvedRequests.add(requestId);
      }
      if (forChild.message !== undefined) {
        answerDeliveryIds.push(
          ...(sourceDelivery.deliveryMetadata ?? [])
            .filter((metadata) => metadata.payloadIndex === sourcePayloadIndex)
            .map((metadata) => metadata.deliveryId),
        );
      }
      const key = JSON.stringify([
        forChild.childContinuationToken,
        forChild.childSessionInbox?.sessionId ?? "",
        forChild.remote?.sessionId ?? "",
        forChild.resolved.event.sequence,
        forChild.resolved.event.stepIndex,
        forChild.resolved.event.turnId,
        forChild.inputSource ?? null,
      ]);
      const child: ChildBucket = children.get(key) ?? {
        workflowAsk: forChild.workflowAsk,
        remote: forChild.remote,
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
  const answered: { event: PendingInputBatchEvent; resolutions: InputResolution[] }[] = [];
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
      const remote = child.remote;
      if (remote !== undefined) {
        const ctx = await deserializeContext(serializedContext);
        const headers = await resolveRemoteAgentStreamHeaders({
          bundle: ctx.require(BundleKey),
          name: remote.name,
          resolverId: remote.resolverId,
          url: remote.url,
        });
        await respondToRemoteAgentSession({
          remote,
          headers,
          auth: sourceDelivery.auth,
          responses: coalesceDeliverPayloads(child.payloads).inputResponses ?? [],
        });
      } else {
        await resumeSessionInbox(
          child.childSessionInbox ?? child.childContinuationToken,
          childDelivery,
        );
      }
    }
    answered.push({ event: child.event, resolutions: [...child.resolutions.values()] });
    // Successfully forwarded request IDs are retired so later deliveries
    // cannot route through stale entries.
    durableSession = retireProxyInputRequests(durableSession, [...child.resolutions.keys()]);
    retired = true;
  }
  const view = sessionView(storedProjection(durableSession.state), durableSession.state);
  const resolvedEvents = [
    ...routeAnswer(view, {
      decided: answered.flatMap((child) => child.resolutions),
      deliveries: routedDeliveries,
      forwarded: answers,
    }).events,
  ];
  // Answers that leave other requests pending, and nothing for the turn itself, keep the
  // open turn held, so it parks again as after a partial approval answer. A forwarded approval
  // stays open until its child settles it, but it no longer waits on the person.
  const forwarded = new Set(
    [...children.values()].flatMap((child) =>
      child.payloads.flatMap((payload) => (payload.inputResponses ?? []).map((r) => r.requestId)),
    ),
  );
  if (
    children.size > 0 &&
    parentPayloads.size === 0 &&
    parentAction === undefined &&
    [...getProxyInputRequests(durableSession.state).keys()].some((id) => !forwarded.has(id))
  ) {
    resolvedEvents.push(...hold(view, { on: "input" }).events);
  }

  let published: PublishedSessionEvents = {
    serializedContext,
    sessionState: retired
      ? replaceDurableSessionSnapshot({ session: durableSession, state: input.sessionState })
      : input.sessionState,
  };
  // Like a steering message, an answering message joins the open turn, so the turn's later events
  // carry its delivery ids too.
  published = {
    ...published,
    serializedContext: joinTurnDeliveryIds(published.serializedContext, answerDeliveryIds),
  };
  const context = await relaySessionEvents(
    { ...published, sessionWritable: input.sessionWritable },
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

function joinTurnDeliveryIds(
  serializedContext: Record<string, unknown>,
  deliveryIds: readonly string[],
): Record<string, unknown> {
  if (deliveryIds.length === 0) return serializedContext;
  const current =
    (serializedContext[TurnDeliveryIdsKey.name] as readonly string[] | undefined) ?? [];
  return {
    ...serializedContext,
    [TurnDeliveryIdsKey.name]: [...new Set([...current, ...deliveryIds])],
  };
}

/**
 * Maps a delivery's channel-specific answers to the requests a held turn waits
 * on, so the turn can tell they answer it. Returns the mapped delivery, or
 * `undefined` when the channel maps none of them to one of `requestIds`.
 */
export async function mapHeldInputResponsesStep(
  input: SessionStepState & {
    readonly delivery: DeliverHookPayload;
    readonly requestIds: readonly string[];
  },
): Promise<WithSessionStateDelta<{ readonly delivery: DeliverHookPayload | undefined }>> {
  "use step";
  return await withSessionStateDelta(input, async () => {
    const requestIds = new Set(input.requestIds);
    const mapped = await deliverChannelInputResponses({
      ...input,
      routable: (response) => requestIds.has(response.requestId),
    });
    return mapped.delivery === input.delivery
      ? { delivery: undefined }
      : { delivery: mapped.delivery, serializedContext: mapped.serializedContext };
  });
}

/**
 * Maps each input response this session cannot route as sent through the
 * channel's `deliver` hook, and routes what it maps to a `routable` request.
 * Telegram buttons, for example, carry compact callback ids that only its hook
 * resolves against channel state. Every other response stays as sent for the
 * turn's own `deliver` call.
 */
async function deliverChannelInputResponses(
  input: SessionStepState & {
    readonly delivery: DeliverHookPayload;
    readonly routable: (response: InputResponse) => boolean;
  },
): Promise<{
  readonly delivery: DeliverHookPayload;
  readonly serializedContext: Record<string, unknown>;
}> {
  const { routable } = input;
  const unrouted = input.delivery.payloads.some(
    (payload) => payload.inputResponses?.some((response) => !routable(response)) === true,
  );
  if (!unrouted) return input;
  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  if (adapter.deliver === undefined) return input;

  // The hook sees this delivery's caller, as it does in the turn.
  if (input.delivery.auth !== undefined) ctx.set(AuthKey, input.delivery.auth ?? null);
  // Each hook call edits its own copy of channel state, kept only when it maps
  // to a routable request; a response put back as sent must stay resolvable.
  let state = adapter.state ?? {};
  let mapped = false;
  const payloads: DeliverPayload[] = [];
  for (const payload of input.delivery.payloads) {
    if (payload.inputResponses === undefined) {
      payloads.push(payload);
      continue;
    }
    const responses: InputResponse[] = [];
    for (const response of payload.inputResponses) {
      if (routable(response)) {
        responses.push(response);
        continue;
      }
      const adapterCtx = buildAdapterContext({ ...adapter, state: structuredClone(state) }, ctx);
      const result = await adapter.deliver(
        { ...payload, inputResponses: [response], message: undefined },
        adapterCtx,
      );
      const routed = result?.inputResponses?.filter(routable) ?? [];
      if (routed.length === 0) {
        responses.push(response);
        continue;
      }
      mapped = true;
      state = adapterCtx.state;
      responses.push(...routed);
    }
    payloads.push({ ...payload, inputResponses: responses });
  }
  if (!mapped) return input;

  // Only the channel state the mapping consumed carries over; the turn applies
  // the rest of this delivery, such as its caller, itself.
  const session = await deserializeContext(input.serializedContext);
  setChannelContext(session, { ...adapter, state });
  return {
    delivery: { ...input.delivery, payloads },
    serializedContext: serializeContext(session),
  };
}
