import { defineEval } from "eve/evals";

export default defineEval({
  description: "Text matching two open relayed questions answers neither and steers the turn.",
  tags: ["hitl", "relayed", "text-reply"],
  timeoutMs: 120_000,
  async test(t) {
    const parked = await t.send("WORKFLOW-TWO-QUESTIONS-START");
    let session = parked.session;
    const requests = new Map(session.pendingInputRequests.map((r) => [r.requestId, r]));
    // Relays can arrive at separate waiting boundaries. Each segment only
    // reports requests emitted in that segment, so retain both request ids.
    for (let attempt = 0; requests.size < 2 && attempt < 4; attempt += 1) {
      session = (
        await t.target
          .watchTurn(session.sessionId, { startIndex: session.state.streamIndex })
          .result()
      ).session;
      for (const request of session.pendingInputRequests) requests.set(request.requestId, request);
    }
    if (requests.size !== 2)
      throw new Error(`Expected two relayed questions, got ${requests.size}.`);
    const typed = (await session.send("Deploy", { turnPolicy: "steer" })).expectOk();
    for (const request of requests.values()) {
      typed.notEvent("input.resolved", {
        data: { resolutions: [{ outcome: "answered", requestId: request.requestId }] },
      });
    }
    typed.event("message.received", { data: { message: "Deploy" } });
    typed.event("message.completed");
  },
});
