import type { EveEvalContext, EveEvalSession, EveEvalTurn } from "eve/evals";

export async function sendAs(
  t: EveEvalContext,
  message: string,
  actor: "A" | "B",
): Promise<EveEvalTurn> {
  const authorization =
    actor === "A" ? "Bearer e2e-hitl-principal-a" : "Bearer e2e-hitl-principal-b";
  const options = { headers: { authorization } };
  const args: unknown[] = t.send.length === 1 ? [{ message, ...options }] : [message, options];
  return (await Reflect.apply(t.send, t, args)) as EveEvalTurn;
}

export function authorizationUrl(turn: EveEvalTurn): URL {
  for (const event of turn.events) {
    if (event.type !== "authorization.required") continue;
    const url = event.data.authorization?.url;
    if (url !== undefined) return new URL(url);
  }
  throw new Error("authorization.required did not expose a callback URL.");
}

export function authorizationId(turn: EveEvalTurn): string {
  const required = turn.events.find((event) => event.type === "authorization.required") as
    | { readonly data: { readonly authorizationId?: unknown } }
    | undefined;
  if (typeof required?.data.authorizationId !== "string") {
    throw new Error("authorization.required did not expose authorizationId.");
  }
  return required.data.authorizationId;
}

export async function invokeCallback(
  t: EveEvalContext,
  turn: EveEvalTurn,
): Promise<{ readonly session: EveEvalSession; readonly turn: EveEvalTurn }> {
  const state = t.state as { readonly streamIndex?: unknown } | undefined;
  if (typeof state?.streamIndex !== "number") throw new Error("Missing auth callback cursor.");
  const url = authorizationUrl(turn);
  const response = await t.target.fetch(`${url.pathname}${url.search}`);
  if (!response.ok) throw new Error(`Authorization callback failed (${String(response.status)}).`);
  const live = t.target.watchTurn(turn.sessionId, { startIndex: state.streamIndex });
  return { session: live.session, turn: await live.result() };
}

export async function verifyFollowUp(
  session: { send(message: string): Promise<EveEvalTurn> },
  sessionId: string,
  marker: string,
): Promise<void> {
  const followUp = await session.send(`Do not call tools. Reply with exactly ${marker}.`);
  followUp.expectOk();
  if (followUp.sessionId !== sessionId) throw new Error("Auth follow-up changed session identity.");
  followUp.event("message.received", { count: 1 });
  followUp.event("message.completed", { count: 1 });
  followUp.event("session.waiting", { count: 1 });
  followUp.messageIncludes(marker);
  followUp.usedNoTools();
}

export function gateLifecycle(t: EveEvalContext): void {
  if (process.env.EVE_HITL_LIFECYCLE_CONTRACT !== "1") {
    t.skip("Nonblocking authorization lifecycle is not active yet.");
  }
}
