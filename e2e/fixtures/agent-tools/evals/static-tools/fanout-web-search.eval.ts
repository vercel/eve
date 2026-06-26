import type { HandleMessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

const TOOL_NAME = "web_search";
const SEARCH_QUERIES = [
  "Vercel AI Gateway documentation",
  "Anthropic Claude API documentation",
  "OpenAI API documentation",
  "Node.js fetch documentation",
  "React useEffect documentation",
  "TypeScript handbook generics",
  "MDN Fetch API documentation",
  "GitHub Actions documentation",
  "AWS Lambda documentation",
  "Google Search Central documentation",
] as const;
const EXPECTED_SEARCH_QUERIES = new Set<string>(SEARCH_QUERIES);
const PARALLEL_REQUEST_COUNT = 2;
const QUERIES_PER_REQUEST = SEARCH_QUERIES.length / PARALLEL_REQUEST_COUNT;

function aggregateRequestsPrecedeFirstResult(events: readonly HandleMessageStreamEvent[]): boolean {
  const requests = events.flatMap((event, eventIndex) => {
    if (event.type !== "actions.requested") return [];

    return event.data.actions.flatMap((action) => {
      if (action.kind !== "tool-call" || action.toolName !== TOOL_NAME) return [];
      return [{ callId: action.callId, eventIndex, input: action.input }];
    });
  });
  const firstResultIndex = events.findIndex(
    (event) =>
      event.type === "action.result" &&
      event.data.result.kind === "tool-result" &&
      event.data.result.toolName === TOOL_NAME,
  );
  const queries = requests.flatMap((request) => searchQueries(request.input));

  return (
    firstResultIndex >= 0 &&
    requests.length === PARALLEL_REQUEST_COUNT &&
    new Set(requests.map((request) => request.callId)).size === PARALLEL_REQUEST_COUNT &&
    requests.every(
      (request) =>
        request.eventIndex < firstResultIndex &&
        searchQueries(request.input).length === QUERIES_PER_REQUEST,
    ) &&
    queries.length === SEARCH_QUERIES.length &&
    new Set(queries).size === SEARCH_QUERIES.length &&
    queries.every((query) => EXPECTED_SEARCH_QUERIES.has(query))
  );
}

function searchQueries(input: unknown): readonly string[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return [];

  const queries = Reflect.get(input, "search_queries");
  return Array.isArray(queries) && queries.every((query) => typeof query === "string")
    ? queries
    : [];
}

export default defineEval({
  description: "Provider tools: two aggregate web searches stream before the first result.",
  async test(t) {
    const turn = await t.send(
      [
        `Use the provider-managed \`${TOOL_NAME}\` tool exactly ${PARALLEL_REQUEST_COUNT} times in one tool-use step.`,
        `Each tool call must contain exactly ${QUERIES_PER_REQUEST} \`search_queries\` values.`,
        `Use every literal query exactly once, without rewriting it: ${SEARCH_QUERIES.map((query) => JSON.stringify(query)).join(", ")}.`,
        "Do not use any other tool and do not issue an additional web search after the first result.",
        "After both searches return, give a concise summary of the findings.",
      ].join("\n"),
    );
    turn.expectOk();

    t.succeeded();
    t.calledTool(TOOL_NAME, { count: PARALLEL_REQUEST_COUNT });
    t.noFailedActions();
    turn.eventsSatisfy(
      "both aggregate provider web-search requests precede the first provider result",
      (events) => aggregateRequestsPrecedeFirstResult(events),
    );
  },
});
