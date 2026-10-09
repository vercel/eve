import { defineEval } from "eve/evals";

import { RESEARCH_INTERIM_MESSAGE } from "../task-scenario-text";
import { positionOf, readHookAudit, recordsEveryAgentStart } from "./subagent-hook-audit.shared";

const SCENARIOS = {
  // An agent call is a task: task.started names its call, the call settles with the child's
  // result before task.ended, and child.opened announces the session the task opened.
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
      "child.opened hooks keep the parent state and sandbox writes they make for a helper a background task opens.",
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
        initial.event("content.completed", {
          count: 1,
          data: { phase: "reply", value: RESEARCH_INTERIM_MESSAGE },
        });
        initial.notCalledTool("eve__task_wait");
      }

      const audit = await initial.session.send(scenario.audit);
      audit.expectOk();
      // The parent's dynamic skill stays loadable after delegation.
      for (const turn of [initial, audit]) {
        turn.loadedSkill("delegation-policy", { count: 1, output: /DELEGATION-POLICY:/u });
      }
      audit.calledTool("read_subagent_hooks", { count: 1, status: "completed" });
      const records = readHookAudit(audit);
      t.eventsSatisfy(
        "both hook subscriptions receive the parent's exact child result once",
        (events) => {
          if (records.length !== 8) return false;
          const started = events.find((event) => event.type === "task.started");
          if (started?.type !== "task.started") return false;
          const callId = started.data.startedBy.callId;
          const completion = events.find(
            (event) => event.type === "call.settled" && event.data.callId === callId,
          );
          if (completion?.type !== "call.settled") return false;
          const output = completion.data.output;
          if (typeof output !== "string" || !output.startsWith("WORKFLOW-CHILD:")) return false;
          if (!initial.message?.includes(output)) return false;
          const countOf = (subscriber: string, type: string, extra = (_: unknown) => true) =>
            records.filter(
              (record) => record.subscriber === subscriber && record.type === type && extra(record),
            ).length;
          return (
            records.every(
              (record) => record.sessionId === initial.sessionId && record.callId === callId,
            ) &&
            (["typed", "wildcard"] as const).every(
              (subscriber) =>
                countOf(subscriber, "task.started") === 1 &&
                countOf(subscriber, "task.ended") === 1 &&
                countOf(
                  subscriber,
                  "call.settled",
                  (record) => (record as { output?: string }).output === output,
                ) === 1,
            )
          );
        },
      );
      t.eventsSatisfy(
        "both hook subscriptions record the opened session in parent state and sandbox",
        (events) => recordsEveryAgentStart(records, events, initial.sessionId),
      );
      t.eventsSatisfy("hooks receive the exact published event positions", (events) =>
        records.every((record) =>
          events.some(
            (event) => positionOf(event) === record.position && event.type === record.type,
          ),
        ),
      );
      t.eventsSatisfy("hooks persist parent sandbox files for the next turn", () =>
        records.every((record) => record.sandboxCallId === record.callId),
      );
      t.event("task.started", { data: { name: scenario.task }, count: 1 });
      t.event("child.opened", { data: { name: "workflow-marker" }, count: 1 });
      t.event("task.ended", { data: { outcome: "completed" }, count: 1 });
      t.notEvent("session.ended", { data: { outcome: "failed" } });
      t.notEvent("turn.settled", { data: { outcome: "failed" } });
      t.noFailedActions();
      t.succeeded();
    },
  }),
);
