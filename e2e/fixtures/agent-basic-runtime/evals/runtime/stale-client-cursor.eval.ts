import { defineEval } from "eve/evals";

export default defineEval({
  description: "A resumed client skips old turns when collecting a newly accepted message.",
  async test(t) {
    const original = t.newSession();
    (await original.send("Reply with first-report-ready.")).expectOk();
    (await original.send("Reply with second-report-ready.")).expectOk();
    const sessionId = original.state?.sessionId;
    if (sessionId === undefined) throw new Error("Expected a started session.");

    // Attachment reads the first boundary, leaving the second turn behind its cursor.
    const resumed = await t.target.attachSession(sessionId, { startIndex: 0 });
    const message = "Reply with current-report-ready.";
    const current = await resumed.send(message);
    current.expectOk();
    current.event("message.received", { count: 1, data: { message } });
    current.event("turn.started", { count: 1, data: { sequence: 2 } });
    current.event("session.waiting", { count: 1 });
  },
});
