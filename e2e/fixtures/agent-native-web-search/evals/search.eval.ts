import { defineEval } from "eve/evals";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Anthropic web search returns result pages; OpenAI web search returns the action it took. */
function isNativeSearchOutput(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(
      (result) =>
        isRecord(result) && result.type === "web_search_result" && typeof result.url === "string",
    );
  }
  return isRecord(value) && isRecord(value.action) && typeof value.action.type === "string";
}

export default defineEval({
  tags: ["real-model"],
  description: "Native Gateway search runs the model vendor's hosted search and cites a source.",
  async test(t) {
    const turn = await t.send(
      [
        "Alice is learning how to map array elements and flatten the results by one level.",
        "Use web_search to find MDN's English reference for Array.prototype.flatMap.",
        "Reply with the reference's title and its URL so she can read it.",
      ].join("\n"),
    );

    turn.expectOk();
    turn
      .calledTool("web_search", { output: isNativeSearchOutput })
      .label("web_search runs the model vendor's hosted search");
    turn.noFailedActions();
    t.messageIncludes(/developer\.mozilla\.org\/[^\s]*flatMap/iu);
  },
});
