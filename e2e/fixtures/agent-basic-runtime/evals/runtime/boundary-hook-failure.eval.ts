import { defineEval } from "eve/evals";

export default defineEval({
  description: "Boundary hook failures leave the current turn and subsequent conversation usable.",
  async test(t) {
    for (const boundary of ["turn.started", "step.started"]) {
      const session = await t.session();
      const current = await session.send("Alice asks Bob to reply with ready.", {
        headers: { "x-e2e-fail-hook": boundary },
      });
      current.expectOk();
      current.event("turn.completed", { count: 1 });
      current.event("session.waiting", { count: 1 });
      current.notEvent("turn.failed");
      current.notEvent("session.failed");
      const next = await session.send("Alice asks Bob to confirm ready again.");
      next.expectOk();
      next.event("turn.started", { count: 1, data: { sequence: 1 } });
      next.notEvent("session.started");
    }
  },
});
