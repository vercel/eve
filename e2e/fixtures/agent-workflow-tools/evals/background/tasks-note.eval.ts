import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { receiptTaskIds } from "./helpers";

/**
 * Alice's reminder starts as a detached task, so her turn holds on it. Her
 * follow-up joins the held turn and sees the working reminder in the
 * `[Tasks]` note. A compaction request waits for the turn to end, so the
 * note after compaction is covered where a turn compacts while it holds.
 */
export default defineEval({
  description: "A follow-up in a held turn sees its working task in the [Tasks] note.",
  timeoutMs: 180_000,
  async test(t) {
    const first = await t.send(
      "Alice would like a reminder about the office plants. BG-NOTE-START",
    );
    first.expectOk();
    first.messageIncludes("BG-STARTED");
    const [taskId] = await t.require(
      receiptTaskIds(first, "remind_later"),
      satisfies(
        (taskIds: readonly string[]) => taskIds.length === 1,
        "the reminder started as a detached task with one receipt",
      ),
    );
    const listed = new RegExp(`<task id="${taskId}" name="remind_later" status="working"`, "u");

    const followUp = await first.session.send("Alice is checking on her reminders. BG-NOTE-CHECK");
    followUp.expectOk();
    followUp.messageIncludes(listed);
    followUp.notEvent("turn.started");
  },
});
