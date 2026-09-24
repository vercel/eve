import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { receiptTaskIds } from "./helpers";

/**
 * Alice's reminder starts as a detached task. While it is still working, her
 * follow-up turn sees it in the `[Tasks]` note, and the note is still there
 * after the session compacts.
 */
export default defineEval({
  description:
    "A follow-up turn sees working tasks in the [Tasks] note, including after compaction.",
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

    const compaction = t.target.watchTurn(first.sessionId, {
      startIndex: followUp.session.state.streamIndex,
    });
    const compacted = await t.target.fetch(
      `/eve/v1/session/${encodeURIComponent(first.sessionId)}/compact`,
      { body: "{}", headers: { "content-type": "application/json" }, method: "POST" },
    );
    await t.require(
      compacted.status,
      satisfies((status: number) => status === 202, "the session accepts compaction"),
    );
    const summary = await compaction.result();
    summary.event("compaction.completed", { count: 1 });

    const afterCompaction = await first.session.send(
      "Alice is checking on her reminders again. BG-NOTE-CHECK",
    );
    afterCompaction.expectOk();
    afterCompaction.messageIncludes(listed);
  },
});
