import type { InputResponse } from "eve/client";
import type { EveEvalContext, EveEvalTurn } from "eve/evals";

export interface CompoundDeliveryResult {
  readonly session: EveEvalContext;
  readonly turn: EveEvalTurn;
}

interface CompoundDelivery {
  readonly inputResponses: readonly InputResponse[];
  readonly message: string;
}

export async function respondToRequests(
  t: EveEvalContext,
  ...responses: InputResponse[]
): Promise<EveEvalTurn> {
  return await t.respond(responses);
}

export async function sendAs(
  t: EveEvalContext,
  message: string,
  authorization: string,
): Promise<EveEvalTurn> {
  return await t.send(message, { headers: { authorization } });
}

export async function respondAs(
  t: EveEvalContext,
  response: InputResponse,
  authorization: string,
): Promise<EveEvalTurn> {
  return await t.respond([response], { headers: { authorization } });
}

export async function sendCompoundDelivery(
  t: EveEvalContext,
  input: CompoundDelivery,
): Promise<CompoundDeliveryResult> {
  // The target interpreter accepts compound deliveries after the lifecycle
  // consolidation; this gated eval intentionally reaches that future surface.
  const send = t.send as unknown as (delivery: CompoundDelivery) => Promise<EveEvalTurn>;
  return { session: t, turn: await send(input) };
}
