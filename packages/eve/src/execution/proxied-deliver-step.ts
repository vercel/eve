import { userPartsOf } from "#harness/user-parts.js";
import { selectDeliveryPayloads } from "#harness/messages.js";
import { routeAnswer } from "#harness/session-machine/transitions.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { principalOf } from "#execution/session/delivery-facts.js";
import { activeTurn, interactionOwner, waiting } from "#protocol/session-projection/selectors.js";
import type { ResponseSubmittedData } from "#protocol/session-events/families/response.js";
import type { SessionInboxAddress } from "#execution/session-inbox/address.js";
import { hasDelegatedSessionContext } from "#execution/delegated-session-context.js";
import { buildAdapterContext } from "#channel/adapter-context.js";
import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import { AuthKey, TurnDeliveryIdsKey } from "#context/keys.js";
import { setChannelContext } from "#execution/channel-context.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import { type DurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { isSteeringDelivery } from "#execution/session/input-queue.js";
import { continueTurnAuth, resolveTurnPrincipal } from "#execution/session/principal.js";
import {
  type PublishedSessionEvents,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import { type WithSessionStateDelta } from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import {
  resolveRemoteAgentStreamHeaders,
  respondToRemoteAgentSession,
} from "#execution/agent-sessions/remote.js";
import { routeDeliverPayload, type RoutedDeliverPayload } from "#subagents/hitl-proxy.js";
import { V26_INPUT_REMOTE_AGENT_PROTOCOL } from "#protocol/remote-agent-protocol.js";
import { protocolTwoAnswersSettledOnForward } from "#subagents/protocol-two-callback.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { sendWorkflowAskAnswers } from "#execution/tools/workflow/answer.js";
import type { WorkflowAskRoute } from "#harness/hitl/relays.js";
import { readHitlState } from "#harness/hitl/index.js";
import { commitSessionStep, publishSessionEvents } from "#execution/publish-session-events.js";
import { fact } from "#harness/facts.js";
import type { Answer } from "#shared/input.js";

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
  readonly remote?: NonNullable<import("#harness/hitl/relays.js").Relay["remote"]>;
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  readonly metadata: NonNullable<DeliverHookPayload["deliveryMetadata"]>[number][];
  readonly payloads: DeliverPayload[];
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
  const requests = readHitlState(readDurableSession(input.sessionState).state).relays;
  const { delivery: sourceDelivery, serializedContext } = await deliverChannelAnswers({
    ...input,
    routable: (response) => requests.has(response.interactionId),
  });
  const durableSession = readDurableSession(input.sessionState);
  const parentPayloads = new Map<number, DeliverPayload>();
  const children = new Map<string, ChildBucket>();
  let parentAction: RoutedDeliverPayload["parentAction"];
  // A typed answer joins the open turn, so only the turn's own principal may
  // send one, as only they steer it. Anyone else's text waits for the turn to
  // end; their button answers still settle a request as its responder.
  const resolveMessage =
    !hasDelegatedSessionContext(serializedContext) &&
    isSteeringDelivery(
      sourceDelivery,
      { callerCallId: undefined, principal: resolveTurnPrincipal(undefined, serializedContext) },
      { heldOnPerson: true },
    );
  // Every payload routes against the same state, so a request a `ctx.ask()`
  // answer or typed reply resolved in an earlier payload is hidden from later
  // ones; it takes one answer, and later messages must reach the parent instead.
  const resolvedRequests = new Set<string>();
  // A message that answers a question is still the person's turn in the
  // conversation, so the stream records it with its delivery ids.
  const answerDeliveryIds: string[] = [];
  let typedAnswer = false;
  // Relayed answers belong to the asking turn's resumed work, even without message text.
  const tables = storedProjection(durableSession.state).view;
  const currentTurn = activeTurn(tables);
  const blocked = currentTurn === undefined ? undefined : waiting(tables, currentTurn.turnId);
  const askedTurn = (row: (typeof tables.interactions)[string]): string | undefined => {
    const owned = interactionOwner(tables, row).turnId;
    if (owned !== undefined && tables.turns[owned]?.status === "running") return owned;
    // Detached tasks have no turn owner, but a task-wait can hold the active turn on their prompts.
    return blocked?.on === "interaction" &&
      blocked.interactions.some((request) => request.interactionId === row.interactionId)
      ? currentTurn?.turnId
      : undefined;
  };
  const routedDeliveries: Parameters<typeof routeAnswer>[1]["deliveries"][number][] = [];
  const answers: ResponseSubmittedData[] = [];

  for (const [sourcePayloadIndex, payload] of sourceDelivery.payloads.entries()) {
    const routed = routeDeliverPayload({
      allowRoute: (interactionId) => !resolvedRequests.has(interactionId),
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
      const askedIn = routed.forChildren
        .flatMap((child) => child.payload.answers)
        .map((response) => tables.interactions[response.interactionId])
        .find((row) => {
          if (row === undefined) return false;
          return askedTurn(row) !== undefined;
        });
      const turnId = askedIn === undefined ? undefined : askedTurn(askedIn);
      // The text joins the asking turn even when the payload leaves fields for this session.
      if (message !== undefined && turnId !== undefined) typedAnswer = true;
      if (routed.forSelf === undefined && turnId !== undefined) {
        answerDeliveryIds.push(...payloadMetadata.map((metadata) => metadata.deliveryId));
      }
      for (const metadata of payloadMetadata) {
        // Input left for this session goes on to its turn, which admits nothing twice.
        routedDeliveries.push({
          consumed:
            routed.forSelf === undefined && turnId !== undefined
              ? {
                  parts: message?.message === undefined ? [] : userPartsOf(message.message),
                  turnId,
                }
              : undefined,
          continues: routed.forSelf === undefined ? undefined : true,
          deliveryId: metadata.deliveryId,
          principal: principalOf(sourceDelivery.auth),
          source:
            metadata.channelKind === undefined ? undefined : { channel: metadata.channelKind },
        });
      }
      for (const forChild of routed.forChildren) {
        for (const response of forChild.payload.answers) {
          const index = (payload.answers ?? []).indexOf(response);
          const value: { optionId?: string; text?: string } = {};
          if (response.optionId !== undefined) value.optionId = response.optionId;
          if (response.text !== undefined) value.text = response.text;
          answers.push({
            deliveryId: answeredBy,
            interactionId: response.interactionId,
            // Named apart from the answers this session's turn admits from the same delivery.
            responseId: `response_${answeredBy}_forwarded_${index === -1 ? `typed_0` : String(index)}`,
            value,
          });
        }
      }
    }

    for (const [childIndex, forChild] of routed.forChildren.entries()) {
      if (forChild.workflowAsk !== undefined || forChild.message !== undefined) {
        for (const { interactionId } of forChild.payload.answers)
          resolvedRequests.add(interactionId);
      }
      const key = JSON.stringify([
        forChild.childContinuationToken,
        forChild.childSessionInbox?.sessionId ?? "",
        forChild.remote?.sessionId ?? "",
        forChild.inputSource ?? null,
        forChild.workflowAsk?.control ?? null,
      ]);
      const child: ChildBucket = children.get(key) ?? {
        workflowAsk: forChild.workflowAsk,
        remote: forChild.remote,
        childContinuationToken: forChild.childContinuationToken,
        childSessionInbox: forChild.childSessionInbox,
        metadata: [],
        payloads: [],
      };
      const childPayloadIndex = child.payloads.length;
      child.payloads.push(forChild.payload);
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

  // Answers that resume a turn own its later events, whether they came from text or buttons.
  // A typed answer also runs as the turn's caller, so it updates the turn's claims.
  const published: PublishedSessionEvents = {
    serializedContext: joinAnswerToTurn(serializedContext, {
      auth: typedAnswer ? sourceDelivery.auth : undefined,
      deliveryIds: answerDeliveryIds,
    }),
    sessionState: input.sessionState,
  };
  // The typed answer's hooks run before it reaches the waiting tool. A hook cancel stops the
  // owner turn instead, leaving the request open for the normal cancellation cascade.
  let cancelled = false;
  const consumed = routedDeliveries.filter((delivery) => delivery.consumed !== undefined);
  const admitted =
    consumed.length === 0
      ? published
      : await commitSessionStep(
          { ...published, sessionWritable: input.sessionWritable },
          (view) => [routeAnswer(view, { deliveries: consumed, forwarded: [], decided: [] })],
          {
            origin: "own",
            cancelTurn: () => {
              cancelled = true;
            },
          },
        );
  if (cancelled) {
    // The turn the answer resumed stopped, so what the delivery left for this session starts no
    // turn of its own.
    const view = storedProjection(readDurableSession(admitted.sessionState).state).view;
    const ignored = (sourceDelivery.deliveryMetadata ?? []).filter(
      ({ deliveryId, payloadIndex }) =>
        parentPayloads.has(payloadIndex) && view.deliveries[deliveryId]?.status !== "settled",
    );
    if (ignored.length === 0) return { ...admitted, kind: "cancel-turn" };
    const settled = await publishSessionEvents(
      { ...admitted, sessionWritable: input.sessionWritable },
      ignored.flatMap(({ channelKind, deliveryId }) => [
        ...(view.deliveries[deliveryId] === undefined
          ? [
              fact("delivery.admitted", {
                deliveryId,
                principal: principalOf(sourceDelivery.auth),
                source: channelKind === undefined ? undefined : { channel: channelKind },
              }),
            ]
          : []),
        fact("delivery.settled", { deliveryId, outcome: "ignored" }),
      ]),
    );
    return {
      kind: "cancel-turn",
      serializedContext: settled.serializedContext,
      sessionState: settled.sessionState,
    };
  }

  // A workflow run publishes nothing of its own: the session settles its questions as it answers.
  const decided: { answer: Answer; outcome: "accepted" | "declined" }[] = [];
  for (const [childKey, child] of children) {
    if (child.workflowAsk !== undefined) {
      const responses = coalesceDeliverPayloads(child.payloads).answers ?? [];
      decided.push(...responses.map((answer) => ({ answer, outcome: "accepted" as const })));
      await sendWorkflowAskAnswers(child.workflowAsk, responses, principalOf(sourceDelivery.auth));
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
          dynamicBinding: remote.dynamicBinding,
          resolverId: remote.resolverId,
          url: remote.url,
        });
        const responses = coalesceDeliverPayloads(child.payloads).answers ?? [];
        await respondToRemoteAgentSession({
          remote,
          headers,
          auth: sourceDelivery.auth,
          // This delivery's answers for this child: a retried step repeats the same delivery.
          idempotencyKey: await answersIdempotencyKey(sourceDelivery, childKey),
          responses,
        });
        // A protocol 2 child relays how its approvals settle, but never its questions or budget
        // prompts: this session settles those as the child takes their answers, as its own
        // protocol did.
        if (remote.earlierProtocol === V26_INPUT_REMOTE_AGENT_PROTOCOL) {
          for (const answer of protocolTwoAnswersSettledOnForward({
            answers: responses,
            decidedHere: parentAction?.answer.interactionId,
            kindOf: (interactionId) => tables.interactions[interactionId]?.request.kind,
          }))
            decided.push({ answer, outcome: "accepted" });
        }
      } else {
        await resumeSessionInbox(
          child.childSessionInbox ?? child.childContinuationToken,
          childDelivery,
        );
      }
    }
  }

  const context = await commitSessionStep(
    { ...admitted, sessionWritable: input.sessionWritable },
    (view) => [
      routeAnswer(view, {
        decided:
          parentAction === undefined
            ? decided
            : [...decided, { answer: parentAction.answer, outcome: "declined" }],
        deliveries: routedDeliveries,
        forwarded: answers,
      }),
    ],
    { origin: "relayed" },
  );
  if (parentAction !== undefined) return { ...context, kind: parentAction.kind };
  const orderedParentPayloads = [...parentPayloads].sort(([a], [b]) => a - b);
  const remainder =
    orderedParentPayloads.length === 0
      ? undefined
      : selectDeliveryPayloads(
          sourceDelivery,
          orderedParentPayloads.map(([index, payload]) => ({ index, payload })),
        );
  return { ...context, kind: "continue", remainder };
}

/**
 * Names one delivery's answers to one child, stable across retries and within the key limit. A
 * delivery that names no delivery ids has nothing stable to name its answers by, so it gets none.
 */
export async function answersIdempotencyKey(
  delivery: DeliverHookPayload,
  childKey: string,
): Promise<string | undefined> {
  const deliveryIds = (delivery.deliveryMetadata ?? []).map((metadata) => metadata.deliveryId);
  if (deliveryIds.length === 0) return undefined;
  const named = JSON.stringify([deliveryIds, childKey]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(named));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"));
  return `eve-answers:${hex.join("")}`;
}

function joinAnswerToTurn(
  serializedContext: Record<string, unknown>,
  answer: { readonly auth: DeliverHookPayload["auth"]; readonly deliveryIds: readonly string[] },
): Record<string, unknown> {
  const joined = { ...serializedContext };
  if (answer.auth !== undefined) {
    joined[AuthKey.name] = continueTurnAuth(
      serializedContext[AuthKey.name] as DeliverHookPayload["auth"],
      answer.auth,
    );
  }
  if (answer.deliveryIds.length > 0) {
    const current = (joined[TurnDeliveryIdsKey.name] as readonly string[] | undefined) ?? [];
    joined[TurnDeliveryIdsKey.name] = [...new Set([...current, ...answer.deliveryIds])];
  }
  return joined;
}

/**
 * Maps a delivery's channel-specific answers to the requests a held turn waits
 * on, so the turn can tell they answer it. Returns the mapped delivery, or
 * `undefined` when the channel maps none of them to one of `requestIds`.
 */
export async function mapHeldAnswersStep(
  input: SessionStepState & {
    readonly delivery: DeliverHookPayload;
    readonly requestIds: readonly string[];
  },
): Promise<WithSessionStateDelta<{ readonly delivery: DeliverHookPayload | undefined }>> {
  "use step";
  return await withSessionStateDelta(input, async () => {
    const requestIds = new Set(input.requestIds);
    const mapped = await deliverChannelAnswers({
      ...input,
      routable: (response) => requestIds.has(response.interactionId),
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
async function deliverChannelAnswers(
  input: SessionStepState & {
    readonly delivery: DeliverHookPayload;
    readonly routable: (response: Answer) => boolean;
  },
): Promise<{
  readonly delivery: DeliverHookPayload;
  readonly serializedContext: Record<string, unknown>;
}> {
  const { routable } = input;
  const unrouted = input.delivery.payloads.some(
    (payload) => payload.answers?.some((response) => !routable(response)) === true,
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
    if (payload.answers === undefined) {
      payloads.push(payload);
      continue;
    }
    const responses: Answer[] = [];
    for (const response of payload.answers) {
      if (routable(response)) {
        responses.push(response);
        continue;
      }
      const adapterCtx = buildAdapterContext({ ...adapter, state: structuredClone(state) }, ctx);
      const result = await adapter.deliver(
        { ...payload, answers: [response], message: undefined },
        adapterCtx,
      );
      const routed = result?.answers?.filter(routable) ?? [];
      if (routed.length === 0) {
        responses.push(response);
        continue;
      }
      mapped = true;
      state = adapterCtx.state;
      responses.push(...routed);
    }
    payloads.push({ ...payload, answers: responses });
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
