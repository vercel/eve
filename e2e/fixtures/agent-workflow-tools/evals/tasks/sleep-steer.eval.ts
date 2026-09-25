import { defineEval } from "eve/evals";

import { waitForStarts } from "./helpers";

/**
 * The agent waits with eve's `sleep` tool, an attached call. A new message
 * stops the sleep through the normal cancel path, and the model reads how
 * long it waited in the same turn.
 */
export default defineEval({
  description: "A steering message stops an attached sleep with the interruption text.",
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
    turn.messageIncludes(/Stopped after \d+ m?s because a new message arrived\./u);
    turn.event("task.started", { count: 1, data: { mode: "attached", name: "sleep" } });
    turn.event("task.settled", { count: 1, data: { status: "cancelled" } });
    turn.notEvent("message.received", { data: { kind: "task.result" } });
  },
});
