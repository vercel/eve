import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description:
    "The installed tracing pipeline retains eve identity and model-step parent relationships.",
  async test(t) {
    const turn = await t.send(
      "Alice is checking the support agent's diagnostics. Call inspect_trace once and report its result.",
    );
    turn.expectOk();
    turn.calledTool("inspect_trace", { count: 1, status: "completed" });
    const result = turn.toolCalls.find((call) => call.name === "inspect_trace")?.output;
    await t.require(
      result,
      satisfies(
        (value: unknown) =>
          typeof value === "object" &&
          value !== null &&
          Reflect.get(value, "modelStep") === true &&
          Reflect.get(value, "identity") === true,
        "the model has its step parent and eve schema identity is preserved",
      ),
    );
  },
});
