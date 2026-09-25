import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { startedTaskIds } from "./helpers";

/**
 * Alice's reminder starts as a detached task, so her turn holds on it and
 * shows its waiting boundary. Her follow-up joins the held turn and sees the
 * working reminder in the `[Tasks]` note.
 */
export default defineEval({
  description: "A follow-up in a held turn sees its working task in the [Tasks] note.",
  timeoutMs: 180_000,
  async test(t) {
    const conversation = await t.session();
    const first = await conversation.start(
      "Alice would like a reminder about the office plants. BG-NOTE-START",
    );
    await first.waitForEvent("turn.completed", { data: { held: true } });
    const [taskId] = await t.require(
      startedTaskIds(first.events, "remind_later"),
      satisfies(
        (taskIds: readonly string[]) => taskIds.length === 1,
        "the reminder started as one detached task",
      ),
    );
    const listed = new RegExp(`<task id="${taskId}" tool="remind_later" status="working"`, "u");

    // Alice keeps writing while the turn holds on the reminder.
    const followUp = await conversation.start("Alice is checking on her reminders. BG-NOTE-CHECK", {
      turnPolicy: "steer",
    });
    await followUp.waitForEvent("message.completed", { data: { message: listed } });
    // The reminder takes minutes; cancelling ends the held turn.
    await conversation.cancel();
    const [turn] = await Promise.all([first.result(), followUp.result()]);
    // One turn: the reply at its waiting boundary, then the note after Alice's message.
    turn.event("message.completed", { count: 1, data: { message: "BG-STARTED" } });
    turn.event("turn.started", { count: 1 });
    turn.event("task.settled", { count: 1, data: { status: "cancelled", taskId } });
    turn.event("task.ended", { count: 1, data: { taskId } });
  },
});
