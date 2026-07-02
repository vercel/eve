import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

/**
 * Core session-route runtime behavior: multi-turn session continuity.
 *
 * Durable session continuity: the second turn runs in the same session and
 * can only answer correctly from context established in the first turn.
 */
export default defineEval({
  description: "Session runtime smoke: multi-turn.",

  async test(t) {
    const first = await t.send("My favorite word is marigold. Remember it.");

    const second = await t.send("What is my favorite word? Reply with just the word.");

    await t.require(second.sessionId, equals(first.sessionId));

    t.succeeded();
    t.messageIncludes(/marigold/i);
  },
});
