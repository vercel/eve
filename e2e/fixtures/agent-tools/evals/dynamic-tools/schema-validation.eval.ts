import { defineEval } from "eve/evals";

export default defineEval({
  description: "Dynamic tool replay preserves input transformations across turns.",
  async test(t) {
    for (let turn = 0; turn < 2; turn++) {
      const result = await t.send(
        'Call `schema_validate` with value "  normalized  ", including the surrounding spaces, and report its returned value.',
      );
      result.expectOk();
      result.calledTool("schema_validate", { output: { value: "normalized" } });
    }
    const invalid = await t.send(
      'Alice is checking a blank form submission. Call `schema_validate` with value " " (one space), then explain the validation result without retrying.',
    );
    invalid.expectOk();
    invalid.calledTool("schema_validate", { status: "failed" });
  },
});
