import { defineEval } from "eve/evals";

import { waitForStarts } from "./helpers";

/**
 * The agent waits with eve's `sleep` tool. A new message ends the sleep early
 * instead of moving it to the background, and the model reads how long it
 * waited.
 */
export default defineEval({
  description: "A steering message ends a waited sleep early.",
  timeoutMs: 120_000,
  async test(t) {
    const session = await t.session();
    const live = await session.start("Alice asked to pause before the next report. BG-SLEEP-START");
    await waitForStarts(t, live, "sleep", 1);

    const message = await live.session.start("Bob here: the report is ready now. BG-PING", {
      turnPolicy: "steer",
    });
    const turn = await live.result();
    await message.result();
    turn.expectOk();
    turn.messageIncludes("BG-SLEPT");
    turn.messageIncludes(/The sleep ended early after \d+ s because a new message arrived\./u);
    turn.event("task.settled", { count: 1, data: { status: "cancelled" } });
    turn.notEvent("task.detached");
    turn.notEvent("message.received", { data: { kind: "task.result" } });
  },
});
