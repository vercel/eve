import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const DURABLE_CONTEXT_TOKEN = "durablectx-acme-Q4M8";
const DURABLE_CONTEXT_TOKEN_PATTERN = /\bdurablectx-[A-Za-z0-9-]+\b/g;

/** Core session-route runtime behavior: client-supplied durable context. */
export default defineEval({
  tags: ["real-model"],
  description: "Session runtime smoke: durable context survives later turns.",

  async test(t) {
    const first = await t.send('Acknowledge this context with exactly "READY".', {
      context: [`The durable context token is ${DURABLE_CONTEXT_TOKEN}.`],
    });
    first.messageIncludes("READY");
    await t.require(
      first.message?.match(DURABLE_CONTEXT_TOKEN_PATTERN) ?? [],
      satisfies<readonly string[]>(
        (observed) => observed.length === 0,
        "does not copy the durable context token into the first assistant response",
      ),
    );

    const second = await t.send(
      "Reply with every token beginning with durablectx- that is visible anywhere in your model input, one per line, and nothing else.",
    );

    t.succeeded();
    await t.require(
      second.message?.match(DURABLE_CONTEXT_TOKEN_PATTERN) ?? [],
      satisfies<readonly string[]>(
        (observed) => observed.filter((token) => token === DURABLE_CONTEXT_TOKEN).length === 1,
        "contains the durable context token exactly once on a later turn",
      ),
    );
  },
});
