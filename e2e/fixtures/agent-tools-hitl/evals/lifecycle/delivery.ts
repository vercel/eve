import type { InputResponse } from "eve/client";
import type { EveEvalContext, EveEvalTurn } from "eve/evals";

export interface CompoundDeliveryResult {
  readonly session: EveEvalContext;
  readonly turn: EveEvalTurn;
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
  input: {
    readonly inputResponses: readonly InputResponse[];
    readonly message: string;
  },
): Promise<CompoundDeliveryResult> {
  const sessionId = t.sessionId;
  const state = t.state;
  if (sessionId === undefined || state === undefined) {
    throw new Error("Compound delivery requires an active eval session.");
  }

  // The high-level client intentionally separates send() from respond().
  // Exercise the protocol's compound envelope directly.
  const response = await t.target.fetch(`/eve/v1/session/${encodeURIComponent(sessionId)}`, {
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: t.signal,
  });
  if (!response.ok) {
    throw new Error(
      `Compound delivery failed (${String(response.status)}): ${await response.text()}`,
    );
  }

  const live = t.target.watchTurn(sessionId, { startIndex: state.streamIndex });
  return { session: t, turn: await live.result() };
}
