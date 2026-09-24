import type { DeliverHookPayload, SessionAuthContext } from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import { DelegatedSessionKey } from "#context/keys.js";
import type { SessionStateMap, StepInput } from "#harness/types.js";
import { hasOwnPendingInput } from "#tasks/input.js";

/** Who answered the session's pending requests in one delivery. */
export interface Answerer {
  readonly auth: SessionAuthContext | null;
}

/**
 * A person's answer never changes who a turn acts for: the turn keeps its
 * principal, and the answer is attributed to whoever gave it, the responder
 * an approval policy checks. Returns the answerer when `delivery` only
 * answers requests, in a delegated session, whose principal is always the
 * one its caller started it with, or in a session that waits on requests
 * of its own, whose answer resumes the turn that asked. Any other delivery
 * acts for its sender.
 */
export function readAnswerer(
  ctx: Pick<ContextContainer, "has">,
  delivery: DeliverHookPayload | undefined,
  state: SessionStateMap | undefined,
): Answerer | undefined {
  if (delivery?.auth === undefined) return undefined;
  const answerOnly =
    delivery.payloads.length > 0 &&
    delivery.payloads.every(
      (payload) => payload.message === undefined && (payload.inputResponses?.length ?? 0) > 0,
    );
  if (!answerOnly || (!ctx.has(DelegatedSessionKey) && !hasOwnPendingInput(state))) {
    return undefined;
  }
  return { auth: delivery.auth ?? null };
}

/** Attributes a delivered answer's responses to the principal that gave them. */
export function attributeAnswer(
  input: StepInput | undefined,
  answerer: Answerer | undefined,
): StepInput | undefined {
  if (answerer === undefined || input?.inputResponses === undefined) return input;
  return {
    ...input,
    attributedInputResponses: input.inputResponses.map((response) => ({
      auth: answerer.auth,
      response,
    })),
  };
}
