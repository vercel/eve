/**
 * Ranking for `search` and for `execute`'s suggestions when a name is unknown.
 * Query and text split into lowercase words (camelCase and punctuation are
 * boundaries), so `create issue`, `createIssue`, and `create_issue` are the
 * same words. Matches rank in tiers:
 *
 * 1. Exact: the query's words are the name's words. A connection tool's full
 *    name ranks just above its name without the connection prefix.
 * 2. Prefix: the name's words start with the query's words, the last of which
 *    may be partial, so `linear` and `create_iss` find `linear__create_issue`.
 * 3. Keyword: any other match. A query word matches a word when either is a
 *    prefix of the other, so `repo` finds `repositories` and `issues` finds
 *    `issue`, and each query word adds the weight of every field it matches.
 *
 * Within a tier, the keyword score orders matches, then connection, then name.
 */

import { connectionToolName } from "#connections/ownership.js";
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
    .map((candidate) => ({ candidate, ...rankCandidate(terms, candidate) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        a.tier - b.tier ||
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

const Tier = { exact: 0, exactWithoutPrefix: 1, prefix: 2, keyword: 3 } as const;

function rankCandidate(
  terms: readonly string[],
  candidate: RankCandidate,
): { readonly score: number; readonly tier: number } {
  if (terms.length === 0) return { score: 1, tier: Tier.keyword };
  const ownName = tokenize(candidate.name);
  const fullName =
    candidate.connection === undefined
      ? ownName
      : tokenize(connectionToolName(candidate.connection.name, candidate.name));
  const tier = sameWords(fullName, terms)
    ? Tier.exact
    : sameWords(ownName, terms)
      ? Tier.exactWithoutPrefix
      : startsWithWords(fullName, terms) || startsWithWords(ownName, terms)
        ? Tier.prefix
        : Tier.keyword;
  return { score: scoreFields(terms, candidateFields(candidate)), tier };
}

function sameWords(words: readonly string[], terms: readonly string[]): boolean {
  return words.length === terms.length && terms.every((term, index) => words[index] === term);
}

/** The last term may be a partial word. */
function startsWithWords(words: readonly string[], terms: readonly string[]): boolean {
  return (
    terms.length <= words.length &&
    terms.every((term, index) =>
      index === terms.length - 1 ? words[index]!.startsWith(term) : words[index] === term,
    )
  );
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
