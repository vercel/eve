import { defineEval } from "eve/evals";

export default defineEval({
  description: "Boundary hook failures end one turn while the conversation remains resumable.",
  async test(t) {
    for (const boundary of ["turn.started", "step.started"]) {
      const session = t.newSession();
      const failed = await session.send("Deny this turn.", {
        headers: { "x-e2e-deny-boundary": boundary },
      });
      failed.event("turn.failed", { count: 1, data: { code: "EVENT_HANDLER_FAILED" } });
      failed.event("session.waiting", { count: 1 });
      failed.notEvent("session.failed");
      const recovered = await session.send("Reply with ready.");
      recovered.expectOk();
      recovered.event("turn.started", { count: 1, data: { sequence: 1 } });
      recovered.notEvent("session.started");
    }
  },
});
