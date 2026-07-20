import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { postChannel } from "./shared";

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
    await t.require(
      payload,
      satisfies(
        (value: { ok: boolean; sessionId?: string }) =>
          value.ok === true && typeof value.sessionId === "string",
        "webhook returns a session id",
      ),
    );

    const session = await t.target.attachSession(payload.sessionId!);
    session.succeeded();
    session.event("message.completed");
    session.messageIncludes("hello");

    t.succeeded();
  },
});
