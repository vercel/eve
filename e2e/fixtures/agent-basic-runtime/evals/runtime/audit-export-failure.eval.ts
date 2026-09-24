import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "An audit hook that throws on turn.started and step.started leaves the turn and the conversation running.",
  async test(t) {
    const session = await t.session();
    const auth = { authorization: "Bearer workspace-carol" };

    const first = await session.send(
      "Carol asks for a one-sentence status update. Reply without calling tools.",
      {
        headers: auth,
      },
    );
    first.expectOk();
    first.event("step.started");
    first.event("turn.completed", { count: 1 });
    first.event("session.waiting", { count: 1 });
    first.notEvent("turn.cancelled");
    first.notEvent("turn.failed");
    first.notEvent("session.failed");

    const next = await session.send(
      "Carol asks for one more sentence on what changed. Reply without calling tools.",
      { headers: auth },
    );
    next.expectOk();
    next.event("turn.started", { count: 1, data: { sequence: 1 } });
    next.event("turn.completed", { count: 1 });
    next.notEvent("session.started");
  },
});
