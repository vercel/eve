import { defineEval } from "eve/evals";

// One resolver returns a helper-built tool (closing over the helper
// param and handler vars) and an inline tool; both survive replay.
export default defineEval({
  description:
    "Dynamic tools smoke: helper-built and inline tools from one resolver survive replay.",
  async test(t) {
    const first = await t.send(
      "Call the `dynamic-nested__nested_query` tool and tell me exactly what it returned.",
    );
    first.expectOk();

    const second = await t.send(
      "Now call the `dynamic-nested__nested_status` tool and tell me exactly what it returned.",
    );
    second.expectOk();

    t.didNotFail();
    t.completed();
    t.calledTool("dynamic-nested__nested_query", {
      isError: false,
      output: { action: "query", endpoint: "/v2/query", source: "helper" },
    });
    t.calledTool("dynamic-nested__nested_status", {
      isError: false,
      output: { tier: "premium", source: "inline" },
    });
  },
});
