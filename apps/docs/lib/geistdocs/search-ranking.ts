interface SearchResult {
  readonly content: unknown;
  readonly type: string;
}

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Fumadocs scores every heading and paragraph as its own document, so a page that
// only mentions a term in a one-word line (e.g. `slackContinuationToken`) can
// outrank the page titled with that term.
const titleRank = (title: unknown, query: string): number => {
  if (typeof title !== "string") return 3;
  const normalized = normalize(title);
  if (normalized === query) return 0;
  const word = new RegExp(`(^|[^a-z0-9])${escapeRegExp(query)}($|[^a-z0-9])`);
  if (normalized.startsWith(query) && word.test(normalized)) return 1;
  if (word.test(normalized)) return 2;
  return 3;
};

/**
 * Moves pages whose title matches the query ahead of pages that only mention it,
 * keeping the search engine's order otherwise. Results arrive as page groups: a
 * `page` entry followed by its matching headings and text.
 */
export function rankTitleMatches<T extends SearchResult>(
  results: readonly T[],
  query: string,
): T[] {
  const term = normalize(query);
  if (term === "") return [...results];

  const groups: T[][] = [];
  for (const result of results) {
    if (result.type === "page" || groups.length === 0) groups.push([result]);
    else groups.at(-1)!.push(result);
  }

  return groups
    .map((group, index) => ({ group, index, rank: titleRank(group[0]!.content, term) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .flatMap(({ group }) => group);
}
