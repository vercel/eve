/**
 * Keyword ranking for `search` and for `execute`'s suggestions when a name is
 * unknown. Query and field text split into lowercase words (camelCase and
 * punctuation are boundaries); a query word matches a field word when either
 * is a prefix of the other, so `repo` finds `repositories` and `issues` finds
 * `issue`. Each query word adds the weight of every field it matches, so broad
 * fields rank below an entry's own name.
 */

import { isObject } from "#shared/guards.js";

/** What the ranker reads from one catalog entry. */
export interface RankCandidate {
  /** The entry's own name; a connection tool's name without its connection prefix. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly connection?: { readonly description: string; readonly name: string };
}

/** Candidates matching `query`, best first. An empty query matches every candidate. */
export function rankCandidates<T extends RankCandidate>(
  query: string,
  candidates: readonly T[],
): T[] {
  const terms = tokenize(query);
  return candidates
    .map((candidate) => ({
      candidate,
      score: terms.length === 0 ? 1 : scoreFields(terms, candidateFields(candidate)),
    }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.candidate.connection?.name ?? "").localeCompare(b.candidate.connection?.name ?? "") ||
        a.candidate.name.localeCompare(b.candidate.name),
    )
    .map((entry) => entry.candidate);
}

/** Names of the candidates closest to an unknown `name`, best first. */
export function closestNames(
  name: string,
  candidates: readonly RankCandidate[],
  limit: number,
): string[] {
  if (tokenize(name).length === 0) return [];
  return rankCandidates(name, candidates)
    .slice(0, limit)
    .map((candidate) => candidate.name);
}

type Field = readonly [words: readonly string[], weight: number];

function candidateFields(candidate: RankCandidate): Field[] {
  const properties = isObject(candidate.inputSchema?.properties)
    ? Object.entries(candidate.inputSchema.properties)
    : [];
  const propertyDescriptions = properties.flatMap(([, schema]) =>
    isObject(schema) && typeof schema.description === "string" ? [schema.description] : [],
  );
  return [
    [tokenize(candidate.name), 6],
    [tokenize(candidate.connection?.name ?? ""), 4],
    [properties.flatMap(([key]) => tokenize(key)), 3],
    [tokenize(candidate.description), 2],
    [propertyDescriptions.flatMap(tokenize), 1],
    [tokenize(candidate.connection?.description ?? ""), 1],
  ];
}

function scoreFields(terms: readonly string[], fields: readonly Field[]): number {
  let score = 0;
  for (const term of terms) {
    for (const [words, weight] of fields) {
      if (words.some((word) => matchesWord(word, term))) score += weight;
    }
  }
  return score;
}

function matchesWord(word: string, term: string): boolean {
  return word.startsWith(term) || (word.length >= 3 && term.startsWith(word));
}

function tokenize(text: string): string[] {
  return text
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 1);
}
