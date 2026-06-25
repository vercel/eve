import { defineEval } from "eve/evals";
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
    plain.notEvent("result.completed");

    t.succeeded();
    // Real models choose their own field values; assert schema conformance
    // rather than an exact payload.
    structured.outputMatches(StructuredOutput);
  },
});
