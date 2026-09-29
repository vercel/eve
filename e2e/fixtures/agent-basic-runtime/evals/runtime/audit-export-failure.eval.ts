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
    first.event("turn.completed", { count: 1 });
    first.event("session.waiting", { count: 1 });
    first.notEvent("turn.cancelled");
    first.notEvent("turn.failed");
    first.notEvent("session.failed");
    const turnStarted = first.events.find((event) => event.type === "turn.started");
    const stepStarted = first.events.find((event) => event.type === "step.started");

    const next = await session.send(
      "Carol asks which audit events are still waiting to be exported. Call read_audit_outbox once and report what it returns.",
      { headers: auth },
    );
    next.expectOk();
    next.event("turn.started", { count: 1, data: { sequence: 1 } });
    next.notEvent("session.started");
    next.calledTool("read_audit_outbox", { count: 1, status: "completed" });
    const queued = next.toolCalls.find((call) => call.name === "read_audit_outbox")?.output;
    await t.require(
      queued,
      satisfies(
        (value: unknown) =>
          Array.isArray(value) &&
          [turnStarted, stepStarted].every(
            (event) =>
              event !== undefined &&
              (value as QueuedAuditEvent[]).some(
                (entry) => entry.eventId === event.meta.id && entry.type === event.type,
              ),
          ),
        "the audit hook queued the first turn's turn.started and step.started before throwing",
      ),
    );
  },
});
