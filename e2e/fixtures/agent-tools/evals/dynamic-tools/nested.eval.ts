import { defineEval } from "eve/evals";

// One resolver returns a helper-built tool (closing over the helper
// param and handler vars) and an inline tool; both survive replay.
export default defineEval({
  description:
    "Dynamic tools smoke: helper-built and inline tools from one resolver survive replay.",
  async test(t) {
    const first = await t.send(
      "Call the `nested_query` tool and tell me exactly what it returned.",
    );
    first.expectOk();

    await t.send("Now call the `nested_status` tool and tell me exactly what it returned.");

    t.completed();
    t.calledTool("nested_query", {
      status: "completed",
      output: { action: "query", endpoint: "/v2/query", source: "helper" },
    });
    t.calledTool("nested_status", {
      status: "completed",
      output: { tier: "premium", source: "inline" },
    });
  },
});
