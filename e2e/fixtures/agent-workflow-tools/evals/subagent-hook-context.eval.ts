import { defineEval } from "eve/evals";

import { RESEARCH_INTERIM_MESSAGE } from "../task-scenario-text";
import { readHookAudit, recordsEveryAgentStart } from "./subagent-hook-audit.shared";

const SCENARIOS = {
  // An agent call is a task: task.started and task.settled carry its callId,
  // and agent.started announces the session the call opened.
  direct: {
    description:
      "Delegation and later wildcard hooks continue after a typed hook writes parent state and throws.",
    task: "workflow-marker",
    request: "Alice asks Bob to review a short report and return his result. SUBAGENT-HOOKS:direct",
    audit:
      "Alice reviews the recorded hook observations for Bob's completed report. SUBAGENT-HOOKS:AUDIT",
  },
  // A task whose run opens a helper agent while the parent keeps answering.
  // The parent's slow model step makes a mid-step open likely, not certain;
  // either way the helper's hooks' state and sandbox writes must reach
  // Alice's next turn.
  background: {
    description:
      "agent.started hooks keep the parent state and sandbox writes they make for a helper a background task opens.",
    task: "research_brief",
    request:
      "Alice starts background research on a short report while she keeps planning with the assistant. SUBAGENT-HOOKS:background",
    audit:
      "Alice reviews the recorded hook observations for the finished research. SUBAGENT-HOOKS:AUDIT",
  },
} as const;

export default (["direct", "background"] as const).map((mode) =>
  defineEval({
    description: SCENARIOS[mode].description,
    async test(t) {
      const scenario = SCENARIOS[mode];
      const initial = await t.send(scenario.request);
      initial.expectOk();
      initial.messageIncludes("Alice's hook audit");
      if (mode === "background") {
        initial.event("message.completed", {
          count: 1,
          data: { message: RESEARCH_INTERIM_MESSAGE },
        });
        initial.notCalledTool("eve__task_wait");
      }

      const audit = await initial.session.send(scenario.audit);
      audit.expectOk();
      audit.calledTool("read_subagent_hooks", { count: 1, status: "completed" });
      const records = readHookAudit(audit);
      t.eventsSatisfy(
        "both hook subscriptions receive the parent's exact child result once",
        (events) => {
          if (records.length !== 6) return false;
          const completion = events.find((event) => event.type === "task.settled");
          if (completion?.type !== "task.settled") return false;
          const output = completion.data.output;
          if (typeof output !== "string" || !output.startsWith("WORKFLOW-CHILD:")) return false;
          if (!initial.message?.includes(output)) return false;
          return (
            records.every(
              (record) =>
                record.sessionId === initial.sessionId && record.callId === completion.data.callId,
            ) &&
            (["typed", "wildcard"] as const).every(
              (subscriber) =>
                records.filter(
                  (record) => record.subscriber === subscriber && record.type === "task.started",
                ).length === 1 &&
                records.filter(
                  (record) =>
                    record.subscriber === subscriber &&
                    record.type === "task.settled" &&
                    record.output === output,
                ).length === 1,
            )
          );
        },
      );
      t.eventsSatisfy(
        "both hook subscriptions record the opened session in parent state and sandbox",
        (events) => recordsEveryAgentStart(records, events, initial.sessionId),
      );
      t.eventsSatisfy("hooks receive the exact published event IDs", (events) =>
        records.every((record) =>
          events.some((event) => event.meta.id === record.eventId && event.type === record.type),
        ),
      );
      t.eventsSatisfy("hooks persist parent sandbox files for the next turn", () =>
        records.every((record) => record.sandboxCallId === record.callId),
      );
      t.event("task.started", { data: { name: scenario.task }, count: 1 });
      t.event("agent.started", { data: { name: "workflow-marker" }, count: 1 });
      t.event("task.settled", { data: { status: "completed" }, count: 1 });
      t.notEvent("session.failed");
      t.notEvent("turn.failed");
      t.noFailedActions();
      t.succeeded();
    },
  }),
);
