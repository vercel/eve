import { defineEval } from "eve/evals";

// `big_report` returns 400 rows with `toModelOutput: offloadContent({ maxBytes: 2000 })`.
// The model must get the saved file's path, not the rows, and `bash` must find
// all 400 rows in that file: the tool wrote it through `ctx.getSandbox()`, and
// `bash` reads it from the same sandbox.
export default defineEval({
  description:
    "Sandbox: offloadContent saves a large tool result to a file the model reads with bash.",
  async test(t) {
    await t.send(
      [
        "Call the `big_report` tool with no input.",
        "Its result is large, so you get the path of a file that holds it instead of the rows.",
        'Count the rows in that file with bash (each row has an `"id"` key), then reply with the count followed by the word rows.',
      ].join("\n"),
    );

    t.succeeded();
    t.calledTool("big_report", { output: { rows: /./u } });
    t.calledTool("bash");
    t.messageIncludes(/\b400 rows\b/u);
    // The scripted model reports what the tool result held, so it proves the rows were not inline.
    if (process.env.EVE_E2E_MODEL === "mock") {
      t.messageIncludes(/saved to \/tmp\/\.eve\/tool-results\/big_report-/u);
      t.messageIncludes("rows inline: false");
    }
  },
});
