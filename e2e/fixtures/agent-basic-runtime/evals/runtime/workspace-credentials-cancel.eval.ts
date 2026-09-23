import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A turn.started hook cancels the turn when the caller's workspace credentials fail to load, and the next turn runs once they load.",
  async test(t) {
    const session = await t.session();
    const cancelled = await session.send("Alice asks Bob to summarize the project board.", {
      headers: { "x-e2e-workspace-credentials": "revoked" },
    });
    cancelled.event("turn.cancelled", { count: 1 });
    cancelled.eventOrder([
      { type: "turn.started" },
      { type: "turn.cancelled" },
      { type: "session.waiting" },
    ]);
    cancelled.notEvent("step.started");
    cancelled.notEvent("message.completed");
    cancelled.notEvent("turn.completed");
    cancelled.notEvent("turn.failed");
    cancelled.notEvent("session.failed");

    const next = await session.send("Alice reconnected the workspace and asks Bob again.");
    next.expectOk();
    next.event("turn.started", { count: 1, data: { sequence: 1 } });
    next.event("turn.completed", { count: 1 });
    next.notEvent("turn.cancelled");
  },
});
