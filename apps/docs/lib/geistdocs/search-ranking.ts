import type { SortedResult } from "fumadocs-core/search";

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Fumadocs scores every heading and paragraph as its own document, so a page that
// only mentions a term in a one-word line (e.g. `slackContinuationToken`) can
// outrank the page titled with that term.
const titleRank = ({ content: title, url }: SortedResult, query: string): number => {
  // Integration pages are mostly marketing copy, so they keep the engine's ranking.
  if (url.startsWith("/integrations/")) return 3;
  const normalized = normalize(title);
  if (normalized === query) return 0;
  const match = new RegExp(`(^|[^a-z0-9])${escapeRegExp(query)}($|[^a-z0-9])`).exec(normalized);
  if (!match) return 3;
  return match.index === 0 ? 1 : 2;
};

/**
 * Moves docs pages whose title matches the query ahead of pages that only mention
 * it, keeping the search engine's order otherwise. Results arrive as page groups: a
 * `page` entry followed by its matching headings and text.
 */
export function rankTitleMatches(results: readonly SortedResult[], query: string): SortedResult[] {
  const term = normalize(query);
  if (term === "") return [...results];

  const groups: SortedResult[][] = [];
  for (const result of results) {
    if (result.type === "page" || groups.length === 0) groups.push([result]);
    else groups.at(-1)!.push(result);
  }

  return groups
    .map((group, index) => ({ group, index, rank: titleRank(group[0]!, term) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .flatMap(({ group }) => group);
}
