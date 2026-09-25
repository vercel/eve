import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { receivedResult, startedTaskIds } from "./helpers";

/**
 * Alice drafts notes with a resumable workflow tool. The first call starts a
 * task, and each later call with its taskId sends the running body a request
 * it reads with ctx.receive() and answers with ctx.reply(). Between requests
 * the task is idle, a wait on it says so, and a `done` request returns from
 * the body, which ends the task, so a later send is refused.
 */
export default defineEval({
  description: "A resumable workflow tool takes sends by taskId, idles between them, and ends.",
  timeoutMs: 180_000,
  async test(t) {
    const conversation = await t.session();
    const first = await conversation.send(
      "Alice would like notes on the launch. TASKS-RESUME-START",
    );
    first.expectOk();
    const [taskId] = await t.require(
      startedTaskIds(first.events, "draft_notes"),
      satisfies(
        (taskIds: readonly string[]) => taskIds.length === 1,
        "the notes started as one resumable task",
      ),
    );
    first.event("task.started", {
      count: 1,
      data: { generation: 1, mode: "detached", resumable: true, taskId },
    });
    first.calledTool("draft_notes", {
      count: 1,
      input: { request: "the launch plan" },
      output: { status: "working", taskId },
    });
    first.messageIncludes("Draft 1: the launch plan");
    first.notEvent("task.ended");

    const revised = await conversation.send("Alice asks for a shorter version. TASKS-REVISE");
    revised.expectOk();
    revised.calledTool("draft_notes", {
      count: 1,
      input: { request: "a shorter plan", taskId: taskId! },
      output: { status: "working", taskId },
    });
    revised.event("task.started", { count: 1, data: { generation: 2, taskId } });
    // The revision reaches the model once: through task_wait, or in a task.result
    // message when it settles before the model's next step.
    t.check(
      receivedResult(revised, taskId!, 2),
      satisfies(
        (route: ReturnType<typeof receivedResult>) => route !== undefined,
        "the second draft reached the model through a wait or a task.result message",
      ),
    );
    revised.calledTool("task_wait", { count: 1, output: { status: "idle", taskId } });
    revised.messageIncludes("Draft 2: a shorter plan");
    revised.notEvent("task.ended");

    const closed = await conversation.send("Alice is done with the notes. TASKS-CLOSE");
    closed.expectOk();
    closed.event("task.started", { count: 1, data: { generation: 3, taskId } });
    closed.event("task.settled", {
      count: 1,
      data: { generation: 3, output: "Closed the notes.", status: "completed", taskId },
    });
    closed.event("task.ended", { count: 1, data: { taskId } });
    closed.eventOrder([
      { type: "task.settled", data: { generation: 3, taskId } },
      { type: "task.ended", data: { taskId } },
    ]);
    closed.calledTool("draft_notes", {
      count: 1,
      input: { request: "one more", taskId: taskId! },
      output: { code: "UNKNOWN_TASK" },
      status: "failed",
    });
    closed.messageIncludes("TASKS-CLOSED");
  },
});
