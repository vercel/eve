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
      turn.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
      turn.eventOrder([
        { type: "turn.started" },
        { data: { outcome: "cancelled" }, type: "turn.settled" },
      ]);
      turn.notEvent("model.started");
      turn.notEvent("content.completed");
      turn.notEvent("session.ended");
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
      turn.event("model.started");
      turn.event("turn.settled", { count: 1, data: { outcome: "completed" } });
    },
  }),
];
