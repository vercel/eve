import type { SessionInboxAddress } from "#execution/session-inbox/address.js";
import type { DeliverPayload } from "#channel/types.js";
import { promptQueueHead } from "#protocol/session-projection/reader.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { readHitlState } from "#harness/hitl/index.js";
import type { Relay, WorkflowAskRoute } from "#harness/hitl/relays.js";
import type { SessionStateMap } from "#harness/types.js";
import type { Answer } from "#shared/input.js";
import { answerFromText } from "#channel/resolve-text.js";
import { inputTextKey, readAnswerText } from "#internal/input-text.js";
import { DENY_OPTION_ID } from "#shared/input.js";

export interface RoutedChildDelivery {
  readonly workflowAsk?: WorkflowAskRoute;
  readonly remote?: Relay["remote"];
  readonly inputSource?: string;
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  readonly message?: DeliverPayload["message"];
  readonly payload: { readonly answers: readonly Answer[] };
}

export interface RoutedDeliverPayload {
  readonly forChildren: readonly RoutedChildDelivery[];
  readonly forSelf: DeliverPayload | undefined;
  readonly parentAction: { readonly kind: "cancel-turn"; readonly answer: Answer } | undefined;
}

const CONSUMED_MESSAGE_KEYS: ReadonlySet<string> = new Set(["context", "message", inputTextKey]);

export function routeDeliverPayload(input: {
  readonly allowRoute?: (interactionId: string) => boolean;
  readonly payload: DeliverPayload;
  readonly resolveMessage?: boolean;
  readonly state: SessionStateMap | undefined;
}): RoutedDeliverPayload {
  const relays = readHitlState(input.state).relays;
  const projection = storedProjection(input.state);
  const taken = (interactionId: string) => input.allowRoute?.(interactionId) === false;
  const routeOf = (interactionId: string) =>
    taken(interactionId) ? undefined : relays.get(interactionId);
  const message = resolveMessageAgainstFirstRequest({
    enabled: input.resolveMessage === true,
    payload: input.payload,
    projection,
    routeOf,
    taken,
  });
  const [textAnswer] = message.answers;
  const answers = [...(input.payload.answers ?? []), ...message.answers];

  const byAsker = new Map<string, { relay: Relay; answers: Answer[] }>();
  const unrouted: Answer[] = [];
  const routed = new Set<string>();
  let parentAction: RoutedDeliverPayload["parentAction"];
  for (const answer of answers) {
    const relay = routeOf(answer.interactionId);
    if (relay === undefined) {
      unrouted.push(answer);
      continue;
    }
    if (routed.has(answer.interactionId)) continue;
    routed.add(answer.interactionId);
    const kind = projection.view.interactions[answer.interactionId]?.request.kind;
    if (kind === "budget" && answer.optionId === DENY_OPTION_ID) {
      parentAction = { answer, kind: "cancel-turn" };
    }
    const key = JSON.stringify([
      relay.childContinuationToken,
      relay.childSessionInbox?.sessionId ?? "",
      relay.remote?.sessionId ?? "",
      relay.inputSource ?? null,
      relay.workflowAsk?.control ?? null,
    ]);
    const bucket = byAsker.get(key) ?? { answers: [], relay };
    bucket.answers.push(answer);
    byAsker.set(key, bucket);
  }

  const forChildren = [...byAsker.values()].map(({ answers: routedAnswers, relay }) => ({
    childContinuationToken: relay.childContinuationToken,
    payload: { answers: routedAnswers },
    ...(relay.childSessionInbox !== undefined && { childSessionInbox: relay.childSessionInbox }),
    ...(textAnswer !== undefined &&
      routedAnswers.includes(textAnswer) && { message: input.payload.message }),
    ...(relay.workflowAsk !== undefined && { workflowAsk: relay.workflowAsk }),
    ...(relay.remote !== undefined && { remote: relay.remote }),
    ...(relay.inputSource !== undefined && { inputSource: relay.inputSource }),
  }));

  const remainder: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.payload)) {
    if (key === "answers" || value === undefined) continue;
    if (message.consumed && CONSUMED_MESSAGE_KEYS.has(key)) continue;
    remainder[key] = value;
  }
  if (unrouted.length > 0) remainder.answers = unrouted;
  const forSelf = Object.keys(remainder).length > 0 ? (remainder as DeliverPayload) : undefined;
  return { forChildren, forSelf, parentAction };
}

function resolveMessageAgainstFirstRequest(input: {
  readonly enabled: boolean;
  readonly payload: DeliverPayload;
  readonly projection: ReturnType<typeof storedProjection>;
  readonly routeOf: (interactionId: string) => Relay | undefined;
  readonly taken: (interactionId: string) => boolean;
}): { readonly consumed: boolean; readonly answers: readonly Answer[] } {
  const none = { answers: [], consumed: false };
  if (!input.enabled || (input.payload.answers?.length ?? 0) > 0) return none;
  const text = readAnswerText(input.payload);
  if (text === undefined) return none;
  const first = promptQueueHead(input.projection.view, input.taken);
  if (first === undefined || input.routeOf(first.interactionId) === undefined) return none;
  const answer = answerFromText(text, first);
  return answer === undefined ? none : { answers: [answer], consumed: true };
}
