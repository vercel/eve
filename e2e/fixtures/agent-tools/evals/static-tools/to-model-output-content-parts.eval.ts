import { defineEval } from "eve/evals";

// The `render-pixel` tool returns only a label + base64 string from
// `execute`; the pixels reach the model exclusively through
// `toModelOutput` content parts. Naming the color proves the file part
// arrived as vision input, not as text the model could parrot.
export default defineEval({
  description: "Static tools smoke: toModelOutput content parts deliver an image to the model.",
  async test(t) {
    await t.send(
      'Call the `render-pixel` tool with label "smoke-test", look at the rendered image, ' +
        "and reply with the single word naming its color.",
    );

    t.succeeded();
    t.noFailedActions();
    t.calledTool("render-pixel", {
      output: (value: unknown) =>
        typeof value === "object" &&
        value !== null &&
        (value as Record<string, unknown>).label === "smoke-test",
    });
    t.messageIncludes(/\bred\b/iu);
  },
});
