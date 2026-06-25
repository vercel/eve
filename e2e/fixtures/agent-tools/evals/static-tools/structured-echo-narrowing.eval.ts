import { defineEval } from "eve/evals";

// The action.result must carry the structured object (not a JSON
// string), and the fixture's tool-result-narrowing hook matches it via
// toolResultFrom: a symbol-identity miss throws inside the hook, which
// surfaces as turn.failed and trips the succeeded check.
export default defineEval({
  description: "Static tools smoke: structured tool-result narrowing via toolResultFrom.",
  async test(t) {
    await t.send(
      'Call the `structured-echo` tool with label "smoke-test". Reply with the echoed value verbatim.',
    );

    t.succeeded();
    t.calledTool("structured-echo", {
      output: (value: unknown) =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).echoed === "smoke-test",
    });
  },
});
