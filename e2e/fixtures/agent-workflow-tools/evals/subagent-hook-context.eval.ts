import { defineEval } from "eve/evals";
import type { SubagentHookObservation } from "../subagent-hook-audit";

export default (["direct", "waiting", "background"] as const).map((mode) =>
  defineEval({
    description: `${mode} subagent hooks preserve parent context, skills, and sandbox writes.`,
    async test(t) {
      const initial = await t.send(
        `Alice asks Bob to review a short report and return his result. SUBAGENT-HOOKS:${mode}`,
      );
      initial.expectOk();
      initial.calledTool("load_skill", { count: 1, status: "completed" });
      const marker =
        mode === "direct"
          ? "Alice's hook audit"
          : `hook-audit:${mode === "waiting" ? "blocking" : "background"}`;
      const completed =
        mode === "waiting"
          ? initial
          : await t.target
              .watchTurn(initial.sessionId, { startIndex: initial.session.state.streamIndex })
              .result();
      completed.expectOk();
      completed.messageIncludes(marker);

      const audit = await completed.session.send(
        "Alice reviews the recorded hook observations for Bob's completed report. SUBAGENT-HOOKS:AUDIT",
      );
      audit.expectOk();
      audit.calledTool("load_skill", { count: 1, status: "completed" });
      t.eventsSatisfy("the parent's dynamic skill remains loadable after delegation", () =>
        [initial, audit].every((turn) =>
          String(turn.toolCalls.find((call) => call.name === "load_skill")?.output).includes(
            "DELEGATION-POLICY:",
          ),
        ),
      );
      audit.calledTool("read_subagent_hooks", { count: 1, status: "completed" });
      const observations = audit.toolCalls.find(
        (call) => call.name === "read_subagent_hooks",
      )?.output;
      t.eventsSatisfy(
        "both hook subscriptions receive the parent's exact child result once",
        (events) => {
          if (!Array.isArray(observations) || observations.length !== 4) return false;
          const completion = events.find((event) => event.type === "subagent.completed");
          if (completion?.type !== "subagent.completed") return false;
          if (!completion.data.output.startsWith("WORKFLOW-CHILD:")) return false;
          if (!completed.message?.includes(completion.data.output)) return false;
          const records = observations as SubagentHookObservation[];
          return (
            records.every(
              (record) =>
                record.sessionId === initial.sessionId && record.callId === completion.data.callId,
            ) &&
            (["typed", "wildcard"] as const).every(
              (subscriber) =>
                records.filter(
                  (record) => record.subscriber === subscriber && record.type === "subagent.called",
                ).length === 1 &&
                records.filter(
                  (record) =>
                    record.subscriber === subscriber &&
                    record.type === "subagent.completed" &&
                    record.output === completion.data.output,
                ).length === 1,
            )
          );
        },
      );
      t.eventsSatisfy(
        "hooks receive the exact published event IDs",
        (events) =>
          Array.isArray(observations) &&
          observations.every((record: SubagentHookObservation) =>
            events.some((event) => event.meta.id === record.eventId && event.type === record.type),
          ),
      );
      t.eventsSatisfy(
        "hooks read the parent skill and persist sandbox files for the next turn",
        () =>
          Array.isArray(observations) &&
          observations.every(
            (record: SubagentHookObservation & { sandboxCallId: string | null }) =>
              record.policy.includes("DELEGATION-POLICY:") &&
              record.sandboxCallId === record.callId,
          ),
      );
      t.event("subagent.called", { data: { name: "workflow-marker" }, count: 1 });
      t.event("subagent.completed", { data: { subagentName: "workflow-marker" }, count: 1 });
      t.notEvent("session.failed");
      t.noFailedActions();
      t.succeeded();
    },
  }),
);
