import type { DeliverHookPayload, SessionAuthContext } from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import { DelegatedSessionKey } from "#context/keys.js";
import type { StepInput } from "#harness/types.js";

/** Who answered a delegated session's pending requests in one delivery. */
export interface DelegatedAnswerer {
  readonly auth: SessionAuthContext | null;
}

/**
 * A person's answer never changes who a delegated session acts as: the
 * session keeps the principal its caller started it with, and the answer is
 * attributed to whoever gave it, the responder an approval policy checks.
 * Returns the answerer when `delivery` only answers a delegated session's
 * requests; the session then keeps its principal.
 */
export function readDelegatedAnswerer(
  ctx: Pick<ContextContainer, "has">,
  delivery: DeliverHookPayload | undefined,
): DelegatedAnswerer | undefined {
  if (!ctx.has(DelegatedSessionKey) || delivery?.auth === undefined) return undefined;
  const answerOnly =
    delivery.payloads.length > 0 &&
    delivery.payloads.every(
      (payload) => payload.message === undefined && (payload.inputResponses?.length ?? 0) > 0,
    );
  return answerOnly ? { auth: delivery.auth ?? null } : undefined;
}

/** Attributes a delivered answer's responses to the principal that gave them. */
export function attributeAnswer(
  input: StepInput | undefined,
  answerer: DelegatedAnswerer | undefined,
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
