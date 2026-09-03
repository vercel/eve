import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
const FIRST_CLIENT_CONTEXT_TOKEN = "clientctx-first-W7R2";
const SECOND_CLIENT_CONTEXT_TOKEN = "clientctx-second-P9K4";
const CLIENT_CONTEXT_TOKEN_PATTERN = /\bclientctx-[A-Za-z0-9-]+\b/g;

/**
 * Core session-route runtime behavior: per-turn client context delivery.
 *
 * The first reply omits its context token. The second turn then asks the model
 * to enumerate the token currently visible, proving that only fresh context
 * reaches the model while ordinary session history remains durable.
 */
export default defineEval({
  tags: ["real-model"],
  description: "Session runtime smoke: client context stays turn-local.",

  async test(t) {
    const first = await t.send('Acknowledge this context with exactly "READY".', {
      clientContext: [`The client context token is ${FIRST_CLIENT_CONTEXT_TOKEN}.`],
    });
    first.messageIncludes("READY");

    const second = await t.send(
      "Reply with every token beginning with clientctx- that is visible anywhere in your model input, one per line, and nothing else.",
      {
        clientContext: [`The client context token is ${SECOND_CLIENT_CONTEXT_TOKEN}.`],
      },
    );

    t.succeeded();
    const tokens = second.message?.match(CLIENT_CONTEXT_TOKEN_PATTERN) ?? [];
    await t.require(
      tokens,
      satisfies(
        (observed) =>
          observed.filter((token) => token === SECOND_CLIENT_CONTEXT_TOKEN).length === 1,
        "contains the fresh client context token exactly once",
      ),
    );
    await t.require(
      tokens,
      satisfies(
        (observed) => !observed.includes(FIRST_CLIENT_CONTEXT_TOKEN),
        "does not contain the first turn's client context token",
      ),
    );
  },
});
