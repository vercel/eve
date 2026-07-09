/**
 * Domain popularity from the Tranco top-sites ranking (tranco-list.eu), used
 * to order generated catalog entries by how widely known the provider is.
 * Only the Anthropic MCP directory supplies its own popularity score; Tranco
 * covers everything else — registry-only MCP servers and OpenAPI providers.
 *
 * Fails open: if Tranco is unreachable the caller gets an empty map and
 * entries keep their feed-supplied score (or 0).
 */

const LATEST_LIST_URL = "https://tranco-list.eu/api/lists/date/latest";
const TOP_DOMAINS = 100_000;

export const fetchTrancoRanks = async () => {
  const ranks = new Map();
  try {
    const meta = await (await fetch(LATEST_LIST_URL)).json();
    const response = await fetch(`https://tranco-list.eu/download/${meta.list_id}/${TOP_DOMAINS}`);
    if (!response.ok) throw new Error(`Tranco download failed: ${response.status}`);
    for (const line of (await response.text()).split("\n")) {
      const comma = line.indexOf(",");
      if (comma === -1) continue;
      const rank = Number(line.slice(0, comma));
      const domain = line
        .slice(comma + 1)
        .trim()
        .toLowerCase();
      if (Number.isFinite(rank) && domain) ranks.set(domain, rank);
    }
  } catch (error) {
    console.warn(`Tranco ranks unavailable, popularity limited to feed scores: ${error}`);
  }
  return ranks;
};

/**
 * Log-scaled score comparable to the Anthropic directory's popularity_score
 * (whose top entries sit around 25,000): rank 1 → 24,000, rank 100 → 14,400,
 * rank 10,000 → 4,800, rank 100,000 → 0.
 */
export const trancoScore = (rank) =>
  typeof rank === "number" && rank >= 1
    ? Math.max(0, Math.round(24_000 * (1 - Math.log10(rank) / 5)))
    : 0;

/**
 * Raises each record's `popularity` to its domain's Tranco score — but a
 * popular domain says nothing about which of its many entries matters, so
 * only one representative per domain (the shortest-named, a decent flagship
 * proxy) gets the full boost; the rest decay steeply. `dampener(record)`
 * lets callers discount low-trust feeds (e.g. unverified registry entries).
 */
export const applyTrancoBoost = (records, ranks, domainOf, dampener = () => 1) => {
  const seenPerDomain = new Map();
  for (const record of [...records].sort((a, b) => a.name.length - b.name.length)) {
    const domain = domainOf(record);
    if (!domain) continue;
    const seen = seenPerDomain.get(domain) ?? 0;
    seenPerDomain.set(domain, seen + 1);
    const boost = trancoScore(ranks.get(domain)) * 0.25 ** seen * dampener(record);
    record.popularity = Math.max(record.popularity ?? 0, Math.round(boost));
  }
};
