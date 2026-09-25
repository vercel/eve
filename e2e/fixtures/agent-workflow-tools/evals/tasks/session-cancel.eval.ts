import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { startedTaskIds, waitForStarts } from "./helpers";

/**
 * Alice drafts an agenda, which leaves an idle resumable task, then sets two
 * reminders, and her turn holds on them. Cancelling the session stops the
 * held turn and both working reminders, which settle as cancelled and end,
 * while the idle agenda task is untouched and still takes her revision.
 */
export default defineEval({
  description: "session.cancel() stops the turn and every working task, not idle tasks.",
  timeoutMs: 180_000,
  async test(t) {
    const conversation = await t.session();
    const drafted = await conversation.send("Alice would like an agenda. TASKS-CANCEL-START");
    drafted.expectOk();
    const [draftTaskId] = await t.require(
      startedTaskIds(drafted.events, "draft_notes"),
      satisfies(
        (taskIds: readonly string[]) => taskIds.length === 1,
        "the agenda started as one resumable task",
      ),
    );
    drafted.messageIncludes("Draft 1: the agenda");

    const reminding = await conversation.start("Alice would like two reminders. TASKS-REMIND");
    await reminding.waitForEvent("turn.completed", { data: { held: true } });
    await waitForStarts(t, reminding, "remind_later", 2);
    const reminderIds = startedTaskIds(reminding.events, "remind_later");

    const cancelled = await conversation.cancel();
    await t.require(
      cancelled,
      satisfies(
        (value: typeof cancelled) => value.status === "accepted",
        "cancel request is accepted",
      ),
    );
    const turn = await reminding.result();
    turn.event("turn.cancelled", { count: 1 });
    turn.eventOrder([{ type: "turn.cancelled" }, { type: "session.waiting" }]);
    turn.notEvent("turn.failed");
    for (const taskId of reminderIds) {
      turn.event("task.settled", { count: 1, data: { status: "cancelled", taskId } });
      turn.event("task.ended", { count: 1, data: { taskId } });
    }
    turn.notEvent("task.ended", { data: { taskId: draftTaskId } });
    turn.notEvent("message.received", { data: { kind: "task.result" } });

    const revised = await conversation.send("Alice would like the agenda shorter. TASKS-AGENDA");
    revised.expectOk();
    revised.calledTool("draft_notes", {
      count: 1,
      input: { request: "a shorter agenda", taskId: draftTaskId! },
      output: { status: "working", taskId: draftTaskId },
    });
    revised.event("task.started", { count: 1, data: { generation: 2, taskId: draftTaskId } });
    revised.messageIncludes("Draft 2: a shorter agenda");
  },
});
