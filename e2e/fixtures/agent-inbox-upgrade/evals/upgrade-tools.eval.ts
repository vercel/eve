import { defineEval } from "eve/evals";

export default defineEval({
  description: "The upgrade fixture reports execution provenance and resumes a pending answer.",
  async test(t) {
    const session = t.newSession();
    try {
      const first = await session.send("UPGRADE-read-baseline");
      first.expectOk();
      first.messageIncludes("upgrade-baseline");

      await session.send("UPGRADE-gate-baseline");
      const request = session.requireInputRequest({ toolName: "upgrade_gate" });
      const answered = await session.respond([
        { requestId: request.requestId, optionId: "continue" },
      ]);
      answered.expectOk();
      answered.messageIncludes('"answer":"continue"');
      answered.event("turn.completed", { count: 1 });
      t.noFailedActions();
    } finally {
      if (session.sessionId !== undefined) {
        await t.target.fetch(`/eve/v1/session/${encodeURIComponent(session.sessionId)}/reset`, {
          method: "POST",
        });
      }
    }
  },
});
