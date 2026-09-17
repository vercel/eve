import { defineEval } from "eve/evals";

export default defineEval({
  description: "Dynamic tool replay preserves input transformations and validation across turns.",
  async test(t) {
    for (let turn = 0; turn < 2; turn++) {
      const result = await t.send(
        'Call `schema_validate` with value "  normalized  ", including the surrounding spaces, and report its returned value.',
      );
      result.expectOk();
      result.calledTool("schema_validate", { output: { value: "normalized" } });
    }
    const invalid = await t.send(
      'Alice is checking a blank form submission. Call `schema_validate` with value " " (one space). If the tool reports a validation error, include "Blank value rejected" in your explanation. Do not retry.',
    );
    invalid.expectOk();
    invalid.event("step.completed", { data: { finishReason: "tool-calls" } });
    invalid.notCalledTool("schema_validate");
    invalid.messageIncludes("Blank value rejected");
  },
});
