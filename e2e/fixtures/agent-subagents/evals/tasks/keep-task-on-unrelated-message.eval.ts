import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { taskResultDeliveries, taskStarts } from "./helpers";

const REQUEST = [
  "Hi, this is Alice from the product team.",
  "Please ask the launch-writer to draft the launch announcement for the Orbit Notebook,",
  "and share the draft here when it is ready.",
].join(" ");
const QUESTION = [
  "While that is being drafted, a quick question about something else:",
  "how many days are there in October?",
].join(" ");

/**
 * A message about something else does not stop work in progress. Alice asks
 * an unrelated question while the writer's task is working: the model
 * answers it, keeps the writer's task running without correcting or
 * cancelling it, and shares the draft in the same turn once it arrives.
 */
export default defineEval({
  description: "An unrelated message is answered while the working agent's task keeps running.",
  tags: ["real-model"],
  timeoutMs: 300_000,
  async test(t) {
    const conversation = await t.session();
    const live = await conversation.start(REQUEST);
    const started = await live.waitForEvent("task.started", { data: { name: "launch-writer" } });
    const taskId = started.data.taskId;

    const answered = await conversation.send(QUESTION, { turnPolicy: "steer" });
    answered.expectOk();
    const turn = await live.result();
    turn.expectOk();

    // One turn: the question joined it, and the draft arrived in it.
    turn.event("turn.started", { count: 1 });
    t.check(
      taskStarts(turn.events, "launch-writer"),
      satisfies(
        (calls: ReturnType<typeof taskStarts>) =>
          calls.length === 1 && calls[0]?.taskId === taskId && calls[0].generation === 1,
        "the writer keeps its one task; no second writer starts and nothing new is sent to it",
      ),
    );
    t.check(
      turn.toolCalls.filter((call) => call.name === "launch-writer").length,
      satisfies((count: number) => count === 1, "the question is not forwarded to the writer"),
    );
    turn.notCalledTool("task_cancel");
    turn.event("task.settled", { count: 1, data: { status: "completed", taskId } });
    t.check(
      taskResultDeliveries(turn.events)
        .flat()
        .filter((delivered) => delivered === taskId).length,
      satisfies(
        (count: number) => count <= 1,
        "the draft reaches the model at most once as a task result",
      ),
    );
    turn.messageIncludes(/Orbit Notebook/i);
    t.judge(
      "Across the conversation, the assistant tells Alice that October has 31 days, and it also shares the finished launch announcement draft for the Orbit Notebook.",
      { on: conversation.transcript },
    ).gate(0.7);
    turn.noFailedActions();
  },
});
