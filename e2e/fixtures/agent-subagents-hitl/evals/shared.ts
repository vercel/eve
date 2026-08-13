import type { EveEvalContext, EveEvalTurn } from "eve/evals";

export function gateLifecycle(t: EveEvalContext): void {
  if (process.env.EVE_HITL_LIFECYCLE_CONTRACT !== "1") {
    t.skip("Projected HITL lifecycle events are not active yet.");
  }
}

export async function verifyFollowUp(
  t: EveEvalContext,
  sessionId: string,
  marker: string,
): Promise<EveEvalTurn> {
  const turn = await t.send(`Do not call tools or subagents. Reply with exactly ${marker}.`);
  turn.expectOk();
  if (turn.sessionId !== sessionId) throw new Error("Proxy follow-up changed session identity.");
  turn.event("message.received", { count: 1 });
  turn.event("message.completed", { count: 1 });
  turn.event("session.waiting", { count: 1 });
  turn.notEvent("session.completed");
  turn.messageIncludes(marker);
  turn.usedNoTools();
  turn.succeeded();
  return turn;
}
