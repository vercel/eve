import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import type { SubagentHookObservation } from "../subagent-hook-audit";

export default (["direct", "waiting", "background"] as const).map((mode) =>
  defineEval({
    description: `${mode} subagent delegation delivers typed and wildcard hooks with the parent session context.`,
    async test(t) {
      const initial = await t.send(
        `Alice asks Bob to review a short report and return his result. SUBAGENT-HOOKS:${mode}`,
      );
      initial.expectOk();
      const marker =
        mode === "direct"
          ? "WORKFLOW-CHILD:Alice's hook audit"
          : `WORKFLOW-CHILD:hook-audit:${mode === "waiting" ? "blocking" : "background"}`;
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
      audit.calledTool("read_subagent_hooks", { count: 1, status: "completed" });
      const observations = audit.toolCalls.find(
        (call) => call.name === "read_subagent_hooks",
      )?.output;
      await t.require(
        observations,
        satisfies((value: unknown) => {
          if (!Array.isArray(value) || value.length !== 4) return false;
          const records = value as SubagentHookObservation[];
          const callIds = new Set(records.map((record) => record.callId));
          return (
            callIds.size === 1 &&
            records.every((record) => record.sessionId === initial.sessionId) &&
            (["typed", "wildcard"] as const).every(
              (subscriber) =>
                records.filter(
                  (record) => record.subscriber === subscriber && record.type === "subagent.called",
                ).length === 1 &&
                records.filter(
                  (record) =>
                    record.subscriber === subscriber &&
                    record.type === "subagent.completed" &&
                    record.output?.includes(marker),
                ).length === 1,
            )
          );
        }, "both hook subscriptions receive each event once with the parent id and child output"),
      );
      t.event("subagent.called", { data: { name: "workflow-marker" }, count: 1 });
      t.event("subagent.completed", { data: { subagentName: "workflow-marker" }, count: 1 });
      t.notEvent("session.failed");
      t.noFailedActions();
      t.succeeded();
    },
  }),
);
