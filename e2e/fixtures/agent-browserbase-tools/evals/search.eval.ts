import { defineEval } from "eve/evals";

function referenceUrl(value: string): string | undefined {
  const url = URL.parse(value.replace(/[.,;:!?]+$/u, ""));
  if (url?.origin !== "https://developer.mozilla.org") return undefined;

  const path = url.pathname.replace(/\/$/u, "");
  if (path === "/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/flatMap") {
    return `${url.origin}${path}`;
  }
  return undefined;
}

export default defineEval({
  tags: ["real-model"],
  description: "Browserbase Gateway search finds an MDN reference and the agent cites it.",
  async test(t) {
    const turn = await t.send(
      [
        "Alice is learning how to map array elements and flatten the results by one level.",
        "Use web_search to find MDN's English reference for Array.prototype.flatMap.",
        "Reply with the reference's title and a URL from the search results so she can read it.",
      ].join("\n"),
    );

    turn.expectOk();
    const citedUrls = new Set(
      (turn.message?.match(/https:\/\/[^\s<>"'`)\]]+/gu) ?? [])
        .map(referenceUrl)
        .filter((url) => url !== undefined),
    );
    turn
      .calledTool("web_search", {
        output: (value) => {
          if (
            typeof value !== "object" ||
            value === null ||
            !("query" in value) ||
            !("requestId" in value) ||
            !("results" in value)
          ) {
            return false;
          }
          return (
            typeof value.query === "string" &&
            value.query.trim().length > 0 &&
            typeof value.requestId === "string" &&
            value.requestId.trim().length > 0 &&
            Array.isArray(value.results) &&
            value.results.some(
              (result) =>
                typeof result === "object" &&
                result !== null &&
                !Array.isArray(result) &&
                typeof result.title === "string" &&
                result.title.trim().length > 0 &&
                typeof result.url === "string" &&
                citedUrls.has(referenceUrl(result.url) ?? ""),
            )
          );
        },
      })
      .label("search returns the MDN flatMap reference and the final answer cites it");
    turn.noFailedActions();
  },
});
