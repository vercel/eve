import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A boundary hook's ctx.cancel() cancels the current turn and leaves the conversation usable.",
  async test(t) {
    for (const boundary of ["turn.started", "step.started"]) {
      const session = await t.session();
      const cancelled = await session.send("Alice asks Bob to reply with ready.", {
        headers: { "x-e2e-cancel-hook": boundary },
      });
      cancelled.event("turn.cancelled", { count: 1 });
      cancelled.eventOrder([{ type: "turn.cancelled" }, { type: "session.waiting" }]);
      cancelled.notEvent("message.completed");
      cancelled.notEvent("turn.completed");
      cancelled.notEvent("turn.failed");
      cancelled.notEvent("session.failed");
      const next = await session.send("Alice asks Bob to confirm ready again.");
      next.expectOk();
      next.event("turn.started", { count: 1, data: { sequence: 1 } });
      next.event("turn.completed", { count: 1 });
      next.notEvent("turn.cancelled");
    }
  },
});
