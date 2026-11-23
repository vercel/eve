import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description:
    "A turn.settled hook's ctx.end() permanently retires the session with cause.hook after the turn completes.",
  timeoutMs: 120_000,
  async test(t) {
    const session = await t.session();
    const first = await session.send(
      "[end session] Alice asks for a one-sentence confirmation that the scheduled report finished. Reply without calling tools.",
    );
    first.expectOk();
    first.event("turn.settled", { count: 1, data: { outcome: "completed" } });

    const tail = session.watch({ startIndex: session.state.streamIndex });
    const ended = await tail.waitForEvent("session.ended");
    await t.require(ended.data.outcome, equals("completed"));
    await t.require(ended.data.cause, equals({ hook: "end-session" }));

    const followUp = await t.target.fetch(
      `/eve/v1/session/${encodeURIComponent(first.sessionId)}`,
      {
        body: JSON.stringify({ message: "Follow up after job completion." }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: t.abortSignal,
      },
    );
    await t.require(followUp.status, equals(409));
    await t.require((await followUp.json()).code, equals("session_not_active"));
    t.succeeded();
  },
});
