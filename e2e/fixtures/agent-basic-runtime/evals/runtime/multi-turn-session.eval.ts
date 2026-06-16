import { defineEval } from "eve/evals";

/**
 * Core session-route runtime behavior: multi-turn session continuity.
 *
 * Durable session continuity: the second turn runs in the same session and
 * can only answer correctly from context established in the first turn.
 */
export default defineEval({
  description: "Session runtime smoke: multi-turn.",

  async test(t) {
    await t.send("My favorite word is marigold. Remember it.");
    const firstSessionId = t.sessionId;

    const second = await t.send("What is my favorite word? Reply with just the word.");
    second.expectOk();

    if (t.sessionId !== firstSessionId) {
      throw new Error(
        `Expected both turns in one session; got ${String(firstSessionId)} then ${String(t.sessionId)}.`,
      );
    }

    t.didNotFail();
    t.completed();
    t.messageIncludes(/marigold/i);
  },
});
