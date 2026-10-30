import { defineEval } from "eve/evals";

export default defineEval({
  description: "A successful turn is captured once with its settled conversation history.",
  async test(t) {
    const completed = await t.send("Reply with exactly CAPTURE-E2E-N7Q4.");
    completed.expectOk();
    completed.messageIncludes("CAPTURE-E2E-N7Q4");

    const recalled = await completed.session.send(
      "Read the recalled capture-state JSON. Reply with exactly CAPTURE-STATE-OK if count is 1, sawAssistant is true, and sawMarker is true. Otherwise reply CAPTURE-STATE-BAD.",
    );
    recalled.expectOk();
    recalled.messageIncludes("CAPTURE-STATE-OK");

    t.succeeded();
  },
});
