import { defineEval } from "eve/evals";

import { postChannel } from "./shared.js";

/**
 * Custom-channel eval for cross-channel `args.receive` handoff.
 *
 * The `/webhook` route does not start a session itself; it hands the
 * message to the target channel via `args.receive` and returns the new
 * session id, which we attach to and drive to a turn boundary.
 */
export default defineEval({
  description: "Custom channel smoke: cross-channel receive.",

  async test(t) {
    const payload = await postChannel<{ ok: boolean; sessionId?: string }>(t.target, "/webhook", {
      message: "Reply with the single word: hello.",
    });
    if (payload.ok !== true || typeof payload.sessionId !== "string") {
      throw new Error(`Unexpected webhook response: ${JSON.stringify(payload)}`);
    }

    const session = await t.target.attachSession(payload.sessionId);

    const failures = session.events.filter(
      (event) =>
        event.type === "session.failed" ||
        event.type === "turn.failed" ||
        event.type === "step.failed",
    );
    if (failures.length > 0) {
      throw new Error(`Cross-channel turn failed: ${JSON.stringify(failures)}`);
    }

    const completed = session.events.filter((event) => event.type === "message.completed");
    if (completed.length === 0) {
      throw new Error("Expected at least one message.completed event in the handoff session.");
    }

    t.didNotFail();
    t.completed();
    t.messageIncludes("hello");
  },
});
