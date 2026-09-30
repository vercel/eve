import { defineEval } from "eve/evals";

export default [
  defineEval({
    description:
      "A workspace member whose credential grant was revoked has the turn cancelled before the model runs.",
    async test(t) {
      const session = await t.session();
      const turn = await session.send(
        "Bob asks for a one-sentence status update. Reply without calling tools.",
        {
          headers: { authorization: "Bearer workspace-bob" },
        },
      );
      turn.event("turn.cancelled", { count: 1 });
      turn.eventOrder([
        { type: "turn.started" },
        { type: "turn.cancelled" },
        { type: "session.waiting" },
      ]);
      turn.notEvent("step.started");
      turn.notEvent("message.completed");
      turn.notEvent("turn.completed");
      turn.notEvent("turn.failed");
      turn.notEvent("session.failed");
    },
  }),
  defineEval({
    description: "A workspace member whose credentials load runs the turn normally.",
    async test(t) {
      const session = await t.session();
      const turn = await session.send(
        "Alice asks for a one-sentence status update. Reply without calling tools.",
        {
          headers: { authorization: "Bearer workspace-alice" },
        },
      );
      turn.expectOk();
      turn.event("step.started");
      turn.event("turn.completed", { count: 1 });
      turn.notEvent("turn.cancelled");
    },
  }),
];
