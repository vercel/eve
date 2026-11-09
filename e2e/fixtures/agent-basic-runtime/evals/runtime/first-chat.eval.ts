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
      turn.events.some((event) => event.type === "content.delta"),
      equals(true),
    );
    await t.require(
      turn.events.some((event) => event.type === "content.completed"),
      equals(true),
    );
    await t.require(
      turn.events.some((event) => event.type === "interaction.opened"),
      equals(false),
    );
  },
});
