import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { taskStarts } from "./helpers";

/**
 * Alice asks an agent a question, then a follow-up. The follow-up goes to
 * the same agent by its taskId: the idle agent starts its next turn in the
 * same child session, as the task's second generation, and answers it. A
 * send through a different tool is refused with TASK_MISMATCH.
 */
export default defineEval({
  description: "A follow-up reaches an idle agent through its taskId, in the same child session.",
  timeoutMs: 120_000,
  async test(t) {
    const conversation = await t.session();
    const first = await conversation.send("Alice has a question for the agent. TASKS-AGENT-START");
    first.expectOk();
    const [start] = await t.require(
      taskStarts(first.events, "workflow-marker"),
      satisfies(
        (starts: ReturnType<typeof taskStarts>) =>
          starts.length === 1 &&
          starts[0]?.generation === 1 &&
          starts[0].mode === "detached" &&
          starts[0].resumable &&
          starts[0].child !== undefined,
        "the agent call started one detached, resumable task with a child session",
      ),
    );
    const taskId = start!.taskId;
    first.messageIncludes("WORKFLOW-CHILD:Alice's first question");
    first.notEvent("task.ended");

    const followUp = await conversation.send("Alice has a follow-up. TASKS-FOLLOW-UP");
    followUp.expectOk();
    followUp.calledTool("workflow-marker", {
      count: 1,
      input: { message: "Alice's follow-up", taskId },
      output: { status: "working", taskId },
    });
    followUp.calledTool("draft_notes", {
      count: 1,
      input: { taskId },
      output: { code: "TASK_MISMATCH" },
      status: "failed",
    });
    t.check(
      taskStarts(followUp.events, "workflow-marker"),
      satisfies(
        (starts: ReturnType<typeof taskStarts>) =>
          starts.length === 1 &&
          starts[0]?.taskId === taskId &&
          starts[0].generation === 2 &&
          starts[0].child?.sessionId === start!.child?.sessionId,
        "the follow-up is the same task's second generation, in the same child session",
      ),
    );
    followUp.messageIncludes("WORKFLOW-CHILD:Alice's follow-up");
    followUp.notEvent("task.ended");
  },
});
