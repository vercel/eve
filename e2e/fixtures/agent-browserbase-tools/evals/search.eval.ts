import { defineEval } from "eve/evals";

const QUERY = "site:browserbase.com Browserbase browser infrastructure";

export default defineEval({
  tags: ["real-model"],
  description: "Browserbase Gateway search returns web results that the agent can cite.",
  async test(t) {
    const turn = await t.send(
      [
        "Alice is collecting official Browserbase resources for an onboarding guide.",
        `Use web_search once with the query ${JSON.stringify(QUERY)}.`,
        "Reply with the title and URL of an official Browserbase page from the results.",
      ].join("\n"),
    );

    turn.expectOk();
    turn.calledTool("web_search", {
      count: 1,
      input: { query: QUERY },
      output: (value) => {
        if (
          typeof value !== "object" ||
          value === null ||
          !("requestId" in value) ||
          !("results" in value)
        ) {
          return false;
        }
        return (
          typeof value.requestId === "string" &&
          value.requestId.length > 0 &&
          Array.isArray(value.results) &&
          value.results.some(
            (result) =>
              typeof result === "object" &&
              result !== null &&
              !Array.isArray(result) &&
              typeof result.title === "string" &&
              result.title.length > 0 &&
              typeof result.url === "string" &&
              /^https:\/\/(?:[^/]+\.)?browserbase\.com(?:\/|$)/u.test(result.url),
          )
        );
      },
    });
    turn.noFailedActions();
    turn.messageIncludes("browserbase.com");
  },
});
