/**
 * Ranking for `search` and for `execute`'s suggestions when a name is unknown.
 * Query and text split into lowercase words (camelCase, acronyms, and
 * punctuation are boundaries), so `create issue`, `createIssue`, and
 * `create_issue` are the same words. Matches rank in tiers:
 *
 * 1. Exact: the query's words are the full name's words.
 * 2. Exact without prefix: they are a connection tool's name without its
 *    connection prefix, so `create_issue` finds `linear__create_issue`.
 * 3. Connection: they are the connection's name, or its first whole words,
 *    so `linear` lists the `linear` connection's tools, while `git` leaves
 *    `github`'s tools to the name prefix tier.
 * 4. Name prefix: the name's words start with the query's words, the last of
 *    which may be partial, so `create_iss` finds `create_issue`.
 * 5. Keyword: any other match. A query word matches a word when either is a
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
        compareCodeUnits(a.candidate.connection?.name ?? "", b.candidate.connection?.name ?? "") ||
        compareCodeUnits(a.candidate.name, b.candidate.name),
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

const Tier = { exact: 0, exactWithoutPrefix: 1, connection: 2, namePrefix: 3, keyword: 4 } as const;

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
      : candidate.connection !== undefined &&
          startsWithWholeWords(tokenize(candidate.connection.name), terms)
        ? Tier.connection
        : startsWithWords(fullName, terms) || startsWithWords(ownName, terms)
          ? Tier.namePrefix
          : Tier.keyword;
  return { score: scoreFields(terms, candidateFields(candidate)), tier };
}

function sameWords(words: readonly string[], terms: readonly string[]): boolean {
  return words.length === terms.length && startsWithWholeWords(words, terms);
}

function startsWithWholeWords(words: readonly string[], terms: readonly string[]): boolean {
  return terms.length <= words.length && terms.every((term, index) => words[index] === term);
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
    [proseWords(candidate.description), 2],
    [propertyDescriptions.flatMap(proseWords), 1],
    [proseWords(candidate.connection?.description ?? ""), 1],
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

/** Every word of a name or query, so a one-letter name can still be searched by name. */
function tokenize(text: string): string[] {
  return text
    .replaceAll(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word !== "");
}

/** A description's words, without one-letter words such as `a`. */
function proseWords(text: string): string[] {
  return tokenize(text).filter((word) => word.length > 1);
}

/** Orders by UTF-16 code unit, the same in every locale. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
