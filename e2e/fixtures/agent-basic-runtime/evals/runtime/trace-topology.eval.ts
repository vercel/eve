import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description:
    "The installed tracing pipeline retains eve identity, model-step parents, and explicitly enabled content for the private HTTP channel.",
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
          Reflect.get(value, "identity") === true &&
          Reflect.get(value, "content") === true,
        "the model has its step parent, eve schema identity, and captured input and output content",
      ),
    );
  },
});
