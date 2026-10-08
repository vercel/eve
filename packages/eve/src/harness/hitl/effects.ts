import type { ModelMessage } from "ai";
import type { DeliverHookPayload, DeliverPayload, SessionAuthContext } from "#channel/types.js";
import type { AlsContext } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { PendingAuthorizationResultKey } from "#harness/authorization.js";
import type { Step } from "#harness/step/context.js";
import type { InputResponse } from "#shared/input.js";
import type { ToolInputResponseResponder } from "#tools/definition.js";
import type { EffectCommand } from "./command.js";
import { beforeStep, type BeforeStepArrival, type HumanInputDecision } from "./reducer.js";

type EffectOf<T extends EffectCommand["type"]> = Extract<EffectCommand, { readonly type: T }>;
type EffectOutcome = Promise<readonly BeforeStepArrival[] | void>;

/** Transports only. They never persist session state or publish decision events. */
export interface HumanInputEffectHandlers {
  forwardAnswer(command: EffectOf<"forwardAnswer">): EffectOutcome;
  withdrawQuestion(command: EffectOf<"withdrawQuestion">): EffectOutcome;
  resumeAuthorization(command: EffectOf<"resumeAuthorization">): EffectOutcome;
}

/**
 * Runs decision effects sequentially. Dedupe is by destination/request for relay answers,
 * control/request for withdrawals, and attempt id for callbacks, not by tool call id.
 * The receiving workflow question also settles first-wins by requestId. Durable transport
 * replay is supplied by the enclosing durable workflow step, which recomputes decisions
 * from the same input on retry. No cross-invocation receipts or persisted outbox exist here.
 */
export async function dispatchHumanInputEffects(
  effects: readonly EffectCommand[],
  handlers: HumanInputEffectHandlers,
): Promise<readonly BeforeStepArrival[]> {
  const seen = new Set<string>();
  const arrivals: BeforeStepArrival[] = [];
  for (const effect of effects) {
    let outcome: readonly BeforeStepArrival[] | void = undefined;
    switch (effect.type) {
      case "forwardAnswer": {
        const destination =
          effect.route.control !== undefined
            ? `control:${effect.route.control}`
            : effect.route.remote !== undefined
              ? `remote:${effect.route.remote.url}:${effect.route.remote.sessionId}`
              : `session:${effect.route.childContinuationToken}`;
        const responses = effect.responses.filter((response) => {
          const key = `answer:${destination}:${response.requestId}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (responses.length === 0) continue;
        outcome = await handlers.forwardAnswer({ ...effect, responses });
        break;
      }
      case "withdrawQuestion": {
        const key = `withdraw:${effect.control}:${effect.requestId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        outcome = await handlers.withdrawQuestion(effect);
        break;
      }
      case "resumeAuthorization": {
        const key = `authorization:${effect.result.attemptId ?? effect.result.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        outcome = await handlers.resumeAuthorization(effect);
        break;
      }
      default:
        effect satisfies never;
    }
    arrivals.push(...(outcome ?? []));
  }
  return arrivals;
}

/** Apply the decision before executing any effect; feed outcomes to the next pure decision. */
export async function applyHumanInputDecision(
  step: Pick<Step, "view" | "apply" | "ctx">,
  decision: Pick<HumanInputDecision, "transition" | "effects" | "authorizations">,
  handlers?: HumanInputEffectHandlers,
  history?: {
    readonly commit?: readonly ModelMessage[];
    readonly messages?: readonly ModelMessage[];
    readonly delivery?: DeliverHookPayload;
  },
): Promise<void> {
  const adapted = decision;
  await step.apply(
    history?.commit === undefined
      ? adapted.transition
      : {
          ...adapted.transition,
          commit: [...history.commit, ...(adapted.transition.commit ?? [])],
        },
    history?.messages,
  );
  const arrivals = await dispatchHumanInputEffects(
    adapted.effects,
    handlers ??
      effectHandlers({
        context: step.ctx,
        delivery: history?.delivery,
        forwardedRequestIds: new Set(
          adapted.effects.flatMap((effect) =>
            effect.type === "forwardAnswer"
              ? effect.responses.map((response) => response.requestId)
              : [],
          ),
        ),
      }),
  );
  installAuthorizations(step.ctx, decision.authorizations ?? []);
  if (arrivals.length === 0) return;
  const completion = beforeStep(step.view(), arrivals);
  const completed = completion;
  // Transport completions are facts, not more transport intents.
  if (completed.effects.length > 0)
    throw new TypeError("Human input effect completion produced another effect batch.");
  await step.apply(completed.transition);
  installAuthorizations(step.ctx, completion.authorizations ?? []);
}

function installAuthorizations(
  context: AlsContext | undefined,
  arrivals: NonNullable<HumanInputDecision["authorizations"]>,
): void {
  if (context === undefined) return;
  for (const { result, requester } of arrivals) {
    const previous = context.get(PendingAuthorizationResultKey) ?? [];
    context.setVirtualContext(PendingAuthorizationResultKey, [
      ...previous.filter(
        (item) => (item.attemptId ?? item.name) !== (result.attemptId ?? result.name),
      ),
      result,
    ]);
    if (requester !== null) context.set(AuthKey, requester);
  }
}

/** Existing delivery envelopes carry responder attribution and channel metadata to an asker. */
export function effectHandlers(input: {
  readonly context?: AlsContext;
  readonly delivery?: DeliverHookPayload;
  readonly forwardedRequestIds?: ReadonlySet<string>;
}): HumanInputEffectHandlers {
  return {
    async forwardAnswer({ route, responses }) {
      const delivery: DeliverHookPayload = input.delivery ?? {
        kind: "deliver",
        auth: input.context?.get(AuthKey),
        payloads: [],
      };
      const auth: SessionAuthContext | null | undefined = delivery.auth;
      if (route.control !== undefined) {
        await sendWorkflowAskAnswers(route.control, responses, toToolInputResponseResponder(auth));
      } else if (route.remote !== undefined) {
        if (input.context === undefined)
          throw new TypeError("Remote answers require the session context.");
        const { resolveRemoteAgentStreamHeaders, respondToRemoteAgentSession } =
          await import("#execution/agent-sessions/remote.js");
        const { BundleKey } = await import("#runtime/sessions/runtime-context-keys.js");
        const headers = await resolveRemoteAgentStreamHeaders({
          bundle: input.context.require(BundleKey),
          name: route.remote.name,
          resolverId: route.remote.resolverId,
          url: route.remote.url,
        });
        await respondToRemoteAgentSession({ auth, headers, remote: route.remote, responses });
      } else {
        const { resumeSessionInbox } = await import("#execution/session-inbox/resume.js");
        await resumeSessionInbox(route.childSessionInbox ?? route.childContinuationToken, {
          ...forwardedDelivery(delivery, responses, input.forwardedRequestIds),
        });
      }
    },
    async withdrawQuestion({ control, requestId }) {
      const { resumeHook } = await import("#internal/workflow/runtime.js");
      const { ignoreGoneTarget } = await import("#execution/tasks/workflow-target.js");
      await ignoreGoneTarget(resumeHook(control, { kind: "withdrawn", requestId }));
    },
    async resumeAuthorization({ result, requester }) {
      return [{ type: "authorization.resumed", result, requester }];
    },
  };
}

function toToolInputResponseResponder(
  auth: SessionAuthContext | null | undefined,
): ToolInputResponseResponder | undefined {
  return auth === null || auth === undefined
    ? undefined
    : {
        authenticator: auth.authenticator,
        principalId: auth.principalId,
        principalType: auth.principalType,
      };
}

/**
 * Sends the answers the session accepted to the asking run's control hook,
 * the same ordered inbox its commands use, so an answer the session accepted
 * before an interrupt or cancel reaches the body before them.
 */
async function sendWorkflowAskAnswers(
  control: string,
  responses: readonly InputResponse[] | undefined,
  responder?: ToolInputResponseResponder,
): Promise<void> {
  const { resumeHook } = await import("#internal/workflow/runtime.js");
  for (const { optionId, requestId, text } of responses ?? []) {
    await resumeHook(control, {
      kind: "answer",
      requestId,
      response:
        responder === undefined
          ? { optionId, status: "answered", text }
          : { optionId, responder, status: "answered", text },
    });
  }
}

/** Keep source payload order and remap channel attribution to the forwarded payload indexes. */
export function forwardedDelivery(
  delivery: DeliverHookPayload,
  responses: EffectOf<"forwardAnswer">["responses"],
  forwardedRequestIds: ReadonlySet<string> = new Set(
    responses.map((response) => response.requestId),
  ),
): DeliverHookPayload {
  const remaining = new Map(responses.map((response) => [response.requestId, response]));
  const payloads: DeliverPayload[] = [];
  const metadata: NonNullable<DeliverHookPayload["deliveryMetadata"]>[number][] = [];
  for (const [sourceIndex, source] of delivery.payloads.entries()) {
    const selected = (source.inputResponses ?? []).flatMap((response) => {
      const answer = remaining.get(response.requestId);
      if (answer === undefined) return [];
      remaining.delete(response.requestId);
      return [answer];
    });
    if (selected.length === 0) continue;
    const payloadIndex = payloads.length;
    payloads.push({ inputResponses: selected });
    // Main assigns a source delivery id once: to its first child, and only if nothing
    // in that payload stays with the parent. Subsequent child buckets carry no duplicate id.
    const sourceResponses = source.inputResponses ?? [];
    const staysWithParent =
      Object.entries(source).some(
        ([key, value]) => key !== "inputResponses" && value !== undefined,
      ) || sourceResponses.some((response) => !forwardedRequestIds.has(response.requestId));
    const firstChild = sourceResponses[0]?.requestId;
    if (!staysWithParent && selected.some((response) => response.requestId === firstChild))
      metadata.push(
        ...(delivery.deliveryMetadata ?? [])
          .filter((item) => item.payloadIndex === sourceIndex)
          .map((item) => ({ ...item, payloadIndex })),
      );
  }
  if (remaining.size > 0) payloads.push({ inputResponses: [...remaining.values()] });
  return { ...delivery, payloads, deliveryMetadata: metadata.length === 0 ? undefined : metadata };
}
