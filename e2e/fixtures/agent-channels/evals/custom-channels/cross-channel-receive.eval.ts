import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

import { postChannel } from "./shared";

type MessageResponse = { ok: boolean; sessionId?: string };

/**
 * Custom-channel eval for cross-channel `ctx.to(...).send(...)` handoff and
 * same-address continuation.
 *
 * The `/webhook` route does not start a session itself; it hands the
 * message to the target channel via `ctx.to(...).send(...)`. Reusing the
 * channel address must resume the same durable session.
 */
export default defineEval({
  description: "Custom channel smoke: cross-channel receive and continuation.",

  async test(t) {
    const sessionRef = crypto.randomUUID();
    const first = await postChannel<MessageResponse>(t.target, "/webhook", {
      message: "Reply with exactly: first-turn",
      sessionRef,
    });
    await t.require(
      first,
      satisfies(
        (value: MessageResponse) => value.ok === true && typeof value.sessionId === "string",
        "initial channel delivery creates a session",
      ),
    );

    const initialTurn = await t.target.watchTurn(first.sessionId!).result();
    initialTurn.succeeded();
    initialTurn.event("message.completed");
    initialTurn.messageIncludes("first-turn");

    const followUpTurn = t.target.watchTurn(first.sessionId!, {
      startIndex: initialTurn.events.length,
    });
    const second = await postChannel<MessageResponse>(t.target, "/webhook", {
      message: "Reply with exactly: second-turn",
      sessionRef,
    });
    await t.require(second.sessionId, equals(first.sessionId));

    const followUp = await followUpTurn.result();
    followUp.succeeded();
    followUp.event("message.completed");
    followUp.messageIncludes("second-turn");
  },
});
