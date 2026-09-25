import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { taskStarts } from "./helpers";

const REQUEST = [
  "Hi, this is Bob.",
  "Please ask the launch-writer for a draft of the Orbit Notebook launch announcement.",
  "I will wait here for it.",
].join(" ");
const FOLLOW_UP = [
  "Thanks. Please have the launch-writer make that same draft shorter:",
  "two sentences at most.",
].join(" ");

/**
 * A revision goes to the agent that wrote the draft. After the writer
 * answers, its task is idle; Bob's follow-up is sent to that task with its
 * taskId, which starts the writer's next turn in its existing session
 * instead of starting a new writer.
 */
export default defineEval({
  description: "A follow-up for an idle agent is sent to it by taskId instead of a new agent.",
  tags: ["real-model"],
  timeoutMs: 420_000,
  async test(t) {
    const conversation = await t.session();
    const first = await conversation.send(REQUEST);
    first.expectOk();
    const [start] = await t.require(
      taskStarts(first.events, "launch-writer"),
      satisfies(
        (calls: ReturnType<typeof taskStarts>) => calls.length === 1 && calls[0]?.generation === 1,
        "one launch-writer task wrote the first draft",
      ),
    );
    const taskId = start!.taskId;
    first.messageIncludes(/Orbit Notebook/i);

    const revised = await conversation.send(FOLLOW_UP);
    revised.expectOk();
    revised.calledTool("launch-writer", { count: 1, input: { taskId } });
    t.check(
      taskStarts(revised.events, "launch-writer"),
      satisfies(
        (calls: ReturnType<typeof taskStarts>) =>
          calls.length === 1 &&
          calls[0]?.taskId === taskId &&
          calls[0].generation === 2 &&
          calls[0].child?.sessionId === start!.child?.sessionId,
        "the revision is the same writer's next turn, in its existing session",
      ),
    );
    revised.messageIncludes(/Orbit Notebook/i);
    t.judge(
      "The assistant shares a shortened launch announcement draft for the Orbit Notebook of at most two sentences.",
      { on: revised.message ?? "" },
    ).gate(0.7);
    revised.noFailedActions();
  },
});
