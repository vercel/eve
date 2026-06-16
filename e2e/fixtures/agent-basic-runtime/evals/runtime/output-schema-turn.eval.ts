import { defineEval } from "eve/evals";
import { matches } from "eve/evals/expect";
import { z } from "zod";

const StructuredOutput = z.object({ count: z.number().int(), title: z.string() });

/**
 * Core session-route runtime behavior: structured output turns.
 *
 * The model answers outputSchema turns with schema-conforming structured
 * data; the next plain turn must not leak another `result.completed`.
 */
export default defineEval({
  description: "Session runtime smoke: output schema.",

  async test(t) {
    const structured = await t.send({
      message: "Summarize this turn as structured output.",
      outputSchema: {
        properties: { count: { type: "integer" }, title: { type: "string" } },
        required: ["title", "count"],
        type: "object",
      },
    });
    structured.expectOk();

    const plain = await t.send("Reply normally without structured output.");
    plain.expectOk();
    if (plain.events.some((event) => event.type === "result.completed")) {
      throw new Error("outputSchema leaked into the following turn: saw result.completed.");
    }

    t.didNotFail();
    t.completed();
    // Real models choose their own field values; assert schema conformance
    // rather than an exact payload.
    t.check(structured.data, matches(StructuredOutput));
  },
});
