import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "A two-turn session with transcript and output assertions.",
  tags: ["multi-turn"],

  async test(t) {
    const first = await t.send("Remember marigold.");
    first.messageIncludes("Turn 1: Remember marigold.");

    const second = await t.send("What did I ask you to remember?");
    second.messageIncludes("Turn 2: remembered Remember marigold.");
    t.check(t.transcript, includes("marigold")).label("transcript remembers marigold");
    t.succeeded();
  },
});
