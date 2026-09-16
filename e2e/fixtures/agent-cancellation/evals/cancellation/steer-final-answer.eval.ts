import { defineEval, type EveEvalTargetHandle } from "eve/evals";

async function send(target: EveEvalTargetHandle, threadId: string, message: string) {
  const response = await target.fetch(`/threads/${threadId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, turnPolicy: "steer" }),
  });
  if (!response.ok) throw new Error(`Message rejected: ${response.status}`);
  return (await response.json()) as { sessionId: string };
}

export default defineEval({
  description: "A correction accepted during the final model step continues the same turn.",
  timeoutMs: 240_000,
  async test(t) {
    const threadId = crypto.randomUUID();
    const initial =
      "Alice is reviewing the 2026 report. Reply with exactly REPORT-YEAR-2026 without using tools.";
    const { sessionId } = await send(t.target, threadId, initial);
    const active = t.target.watchTurn(sessionId);
    await active.waitForEvent("message.received", { data: { message: initial } });
    await send(
      t.target,
      threadId,
      "Alice corrects the report year to 2025. Reply with exactly REPORT-YEAR-2025 without using tools.",
    );

    const result = await active.result();
    result.expectOk();
    result.event("turn.started", { count: 1 });
    result.event("message.received", { count: 2 });
    result.event("turn.completed", { count: 1 });
    result.event("step.started", { count: 2 });
    result.notEvent("actions.requested");
    result.notEvent("turn.cancelled");
    result.messageIncludes("REPORT-YEAR-2025");
    t.succeeded();
  },
});
