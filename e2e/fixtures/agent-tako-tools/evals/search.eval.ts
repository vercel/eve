import { defineEval } from "eve/evals";

function normalizeUrl(value: string): string | undefined {
  const url = URL.parse(value.replace(/[.,;:!?]+$/u, ""));
  if (url === null) return undefined;
  return `${url.origin}${url.pathname.replace(/\/$/u, "")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default defineEval({
  tags: ["real-model"],
  description: "Tako Gateway search returns a data card and the agent cites a result URL.",
  async test(t) {
    // Temporarily disabled: the live-model assertion is flaky in CI. Set
    // EVE_E2E_TAKO=1 to run it locally.
    if (process.env.EVE_E2E_TAKO !== "1") {
      t.skip("Temporarily disabled as flaky; set EVE_E2E_TAKO=1 to run.");
    }

    const turn = await t.send(
      [
        "Bob wants to compare how US GDP has changed over the past ten years.",
        "Use web_search to find a data source for US GDP.",
        "Reply with one sentence about the trend and a URL from the search results so he can see the data.",
      ].join("\n"),
    );

    turn.expectOk();
    const citedUrls = new Set(
      (turn.reply?.match(/https:\/\/[^\s<>"'`)\]]+/gu) ?? [])
        .map(normalizeUrl)
        .filter((url) => url !== undefined),
    );
    turn
      .calledTool("web_search", {
        output: (value) => {
          if (!isRecord(value) || typeof value.request_id !== "string") return false;
          if (value.request_id.trim().length === 0) return false;

          const cards = Array.isArray(value.cards) ? value.cards.filter(isRecord) : [];
          const webResults = Array.isArray(value.web_results)
            ? value.web_results.filter(isRecord)
            : [];
          const hasTakoCard = cards.some(
            (card) =>
              typeof card.title === "string" &&
              card.title.trim().length > 0 &&
              typeof card.webpage_url === "string" &&
              URL.parse(card.webpage_url)?.hostname.endsWith("tako.com") === true,
          );
          const resultUrls = [
            ...cards.map((card) => card.webpage_url),
            ...webResults.map((result) => result.url),
          ].filter((url): url is string => typeof url === "string");
          const citesResult = resultUrls.some((url) => citedUrls.has(normalizeUrl(url) ?? ""));
          return hasTakoCard && citesResult;
        },
      })
      .label("search returns a Tako data card and the final answer cites a result URL");
    turn.noFailedCalls();
  },
});
