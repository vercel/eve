import { satisfies } from "eve/evals/expect";

import { defineTaskEval } from "./task-transition.js";
import { requireBackgroundTaskId, requireSessionStreamIndex, requireTaskView } from "./shared.js";

const REVIEW_FINDING = "blocker: task admission can discard deferred user input.";
const PROBE = "TASK-WAKE-OBSERVED-READY-PROBE";

/** A ready result observed by task_peek makes its queued task wake redundant. */
export default defineTaskEval({
  description:
    "A parent peeks a completed reviewer before its ready wake arrives, so the framework drops that wake without starting another turn.",
  transition: {
    primary: "task.parent.wake.suppressed-observed-ready",
    setup: [
      "task.dispatch.start.accepted-acknowledged",
      "task.lifecycle.complete.accepted-nonterminal",
      "task.control.peek.observed-owned",
    ],
    dimensions: { transport: "local", parentPhase: "active" },
  },
  async test(t) {
    const reviewed = await t.send("TASK-WAKE-OBSERVED-READY");
    reviewed.expectOk();
    reviewed.calledSubagent("busy-worker", { count: 1 });
    reviewed.calledTool("task_sleep", { count: 2 });

    const taskId = requireBackgroundTaskId(reviewed);
    const view = requireTaskView(
      reviewed.requireToolCall("task_peek", { input: { taskIds: [taskId] } }).output,
      taskId,
    );
    await t.require(
      view,
      satisfies(
        (task: Record<string, unknown>) => taskResultText(task)?.includes(REVIEW_FINDING) === true,
        "task_peek exposes the completed reviewer result before the ready wake is consumed",
      ),
    );
    reviewed.messageIncludes(`request changes on PR #2277.\n\n- ${REVIEW_FINDING}`);

    const nextTurn = t.target.watchTurn(reviewed.sessionId, {
      startIndex: requireSessionStreamIndex(t, "Observed-ready wake probe"),
    });
    const probe = await t.send(PROBE);
    const observed = await nextTurn.result();

    probe.expectOk();
    probe.messageIncludes(`${PROBE}-ACK`);
    observed.event("message.received", { count: 1, data: { message: PROBE } });
    observed.notEvent("message.received", {
      data: (data) =>
        typeof data.message === "string" && data.message.startsWith("Background task "),
    });
    observed.messageIncludes(`${PROBE}-ACK`);
    t.noFailedActions();
  },
});

function taskResultText(view: Record<string, unknown>): string | undefined {
  if (view.status !== "completed") return undefined;
  const lastOutput = view.lastOutput;
  if (
    lastOutput === null ||
    typeof lastOutput !== "object" ||
    Reflect.get(lastOutput, "type") !== "result"
  ) {
    return undefined;
  }
  const data = Reflect.get(lastOutput, "data");
  return typeof data === "string" ? data : undefined;
}
