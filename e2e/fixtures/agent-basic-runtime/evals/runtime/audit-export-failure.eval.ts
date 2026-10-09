import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import type { QueuedAuditEvent } from "../../agent/lib/workspace";

export default defineEval({
  description:
    "An audit hook that queues its event and throws on turn.started and step.started leaves the turn and the conversation running.",
  async test(t) {
    const session = await t.session();
    const auth = { authorization: "Bearer workspace-carol" };

    const first = await session.send(
      "Carol asks for a one-sentence status update. Reply without calling tools.",
      { headers: auth },
    );
    first.expectOk();
    first.event("turn.settled", { count: 1, data: { outcome: "completed" } });
    first.notEvent("session.ended");

    const next = await session.send(
      "Carol asks which audit events are still waiting to be exported. Call read_audit_outbox once and report what it returns.",
      { headers: auth },
    );
    next.expectOk();
    next.event("turn.started", { count: 1, data: { turnId: "turn_1" } });
    next.notEvent("session.started");
    next.calledTool("read_audit_outbox", { count: 1, status: "completed" });
    const queued = next.toolCalls.find((call) => call.name === "read_audit_outbox")?.output;
    await t.require(
      queued,
      satisfies(
        (value: unknown) =>
          Array.isArray(value) &&
          ["turn.started", "step.started"].every((type) =>
            (value as QueuedAuditEvent[]).some(
              (entry) => entry.type === type && entry.eventId.length > 0,
            ),
          ),
        "the audit hook queued the first turn's turn.started and step.started before throwing",
      ),
    );
  },
});
