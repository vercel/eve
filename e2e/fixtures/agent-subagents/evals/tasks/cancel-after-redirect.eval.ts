import { defineEval, type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { taskStarts } from "./helpers";

const REQUEST = [
  "Hi, this is Alice. I am choosing where to hold tomorrow's team offsite, Lisbon or Oslo.",
  "Please ask the forecaster about both cities at the same time, then compare them for me.",
].join(" ");
const REDIRECT = [
  "Change of plans: Bob just confirmed that the offsite will be in Lisbon,",
  "so we no longer need the Oslo forecast.",
  "Please stop that lookup and just tell me tomorrow's forecast for Lisbon.",
].join(" ");

/** The task a forecaster call about `city` started, from the call's receipt. */
function forecasterTaskId(turn: EveEvalTurn, city: RegExp): string | undefined {
  const call = turn.toolCalls.find(
    (candidate) => candidate.name === "forecaster" && city.test(JSON.stringify(candidate.input)),
  );
  const output = call?.output as { readonly taskId?: unknown } | null | undefined;
  return typeof output?.taskId === "string" ? output.taskId : undefined;
}

/**
 * A redirecting message stops the work it made unnecessary. Alice asks for
 * two forecasts, then says only Lisbon matters while both lookups work: the
 * model stops the Oslo task with task_cancel, keeps the Lisbon task, and
 * answers with Lisbon's forecast in the same turn.
 */
export default defineEval({
  description: "The model cancels a task that a redirecting message made unnecessary.",
  tags: ["real-model"],
  timeoutMs: 300_000,
  async test(t) {
    const conversation = await t.session();
    const live = await conversation.start(REQUEST);
    const first = await live.waitForEvent("task.started", { data: { name: "forecaster" } });
    await live.waitForEvent("task.started", {
      data: { name: "forecaster", taskId: (taskId) => taskId !== first.data.taskId },
    });

    const redirected = await conversation.send(REDIRECT, { turnPolicy: "steer" });
    redirected.expectOk();
    const turn = await live.result();
    turn.expectOk();

    const oslo = await t.require(
      forecasterTaskId(turn, /oslo/iu),
      satisfies(
        (taskId: string | undefined) => taskId !== undefined,
        "Alice's Oslo lookup started",
      ),
    );
    const lisbon = forecasterTaskId(turn, /lisbon/iu);
    turn.calledTool("task_cancel", { input: { taskId: oslo! } });
    t.check(
      turn.toolCalls.filter((call) => call.name === "task_cancel").map((call) => call.input.taskId),
      satisfies(
        (cancelled: readonly unknown[]) => lisbon !== undefined && !cancelled.includes(lisbon),
        "the Lisbon lookup keeps working",
      ),
    );
    // The lookup takes about 15 seconds, so the cancel normally lands first.
    turn.event("task.settled", { count: 1, data: { status: "cancelled", taskId: oslo! } }).soft();
    t.check(
      taskStarts(turn.events, "forecaster").length,
      satisfies((count: number) => count === 2, "no lookup starts again"),
    );
    turn.messageIncludes(/Lisbon/);
    t.judge("The reply gives Alice tomorrow's forecast for Lisbon: about 24 °C and sunny.", {
      on: turn.message ?? "",
    }).gate(0.7);
    turn.noFailedActions();
  },
});
