import { defineEval } from "eve/evals";
import type { EveEvalContext, EveEvalSession, EveEvalTurn } from "eve/evals";

/**
 * An open authorization challenge must not wedge the session: an ordinary
 * message runs as a normal turn while the challenge waits, and the callback
 * still completes it afterwards. Tool re-execution after the callback is
 * covered deterministically by `workflow-entry.integration.test.ts`.
 */
export default defineEval({
  description: "An ordinary message runs while an authorization challenge stays open.",
  async test(t) {
    const parked = await t.send(
      'Call the auth-probe tool exactly once with marker "nonblocking". Include its result.',
    );
    parked.event("authorization.required", { count: 1 });
    parked.notEvent("authorization.completed");
    parked.event("session.waiting", { count: 1 });

    // The wedge case: a message while the challenge is open runs as a
    // normal turn instead of queueing behind the callback.
    const message = await t.send("Do not call any tools. Reply with exactly AUTH-OPEN-MESSAGE-OK.");
    message.expectOk();
    if (message.sessionId !== parked.sessionId) {
      throw new Error("Message while authorization was open changed session identity.");
    }
    message.event("message.received", { count: 1 });
    message.event("message.completed", { count: 1 });
    message.notEvent("authorization.completed");
    message.event("session.waiting", { count: 1 });
    message.messageIncludes("AUTH-OPEN-MESSAGE-OK");
    message.usedNoTools();

    // The callback still lands and closes the challenge exactly once.
    const resumed = await invokeCallback(t, parked);
    resumed.turn.event("authorization.completed", {
      count: 1,
      data: { outcome: "authorized" },
    });
    resumed.turn.notEvent("session.failed");

    // The session stays conversational after the whole sequence.
    const followUp = await resumed.session.send(
      "Do not call tools. Reply with exactly AUTH-OPEN-FOLLOW-UP-OK.",
    );
    followUp.expectOk();
    if (followUp.sessionId !== parked.sessionId) {
      throw new Error("Follow-up after the callback changed session identity.");
    }
    followUp.event("message.completed", { count: 1 });
    followUp.event("session.waiting", { count: 1 });
    followUp.messageIncludes("AUTH-OPEN-FOLLOW-UP-OK");
    followUp.usedNoTools();
  },
});

function authorizationUrl(turn: EveEvalTurn): URL {
  for (const event of turn.events) {
    if (event.type !== "authorization.required") continue;
    const url = event.data.authorization?.url;
    if (url !== undefined) return new URL(url);
  }
  throw new Error("authorization.required did not expose a callback URL.");
}

async function invokeCallback(
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
