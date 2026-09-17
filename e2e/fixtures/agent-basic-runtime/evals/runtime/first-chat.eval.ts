import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description: "A fresh session streams its first answer without an onboarding interview.",
  async test(t) {
    const turn = await t.send(
      'Alice is starting her first chat. Reply with "Ready to chat, Alice." without calling tools.',
    );
    t.succeeded();
    t.usedNoTools();
    t.messageIncludes("Ready to chat, Alice.");
    await t.require(
      turn.events.some((event) => event.type === "message.appended"),
      equals(true),
    );
    await t.require(
      turn.events.some((event) => event.type === "message.completed"),
      equals(true),
    );
    await t.require(
      turn.events.some(
        (event) => event.type === "authorization.required" || event.type === "input.requested",
      ),
      equals(false),
    );
  },
});
