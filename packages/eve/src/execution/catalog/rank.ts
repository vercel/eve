import { connectionToolName } from "#connections/ownership.js";
import { isObject } from "#shared/guards.js";
import type { JsonObject } from "#shared/json.js";
import { followRefs } from "#tools/schema.js";

export interface RankCandidate {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly connection?: { readonly description: string; readonly name: string };
}

export function rankCandidates<T extends RankCandidate>(
  query: string,
  candidates: readonly T[],
): T[] {
  const terms = tokenize(query);
  const scored = scoringTerms(terms);
  return candidates
    .map((candidate) => ({ candidate, ...rankCandidate(terms, scored, candidate) }))
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

export function isEmptyQuery(query: string): boolean {
  return tokenize(query).length === 0;
}

const MAX_SUGGESTIONS = 5;

export function closestNames(name: string, candidates: readonly RankCandidate[]): string[] {
  if (isEmptyQuery(name)) return [];
  return rankCandidates(name, candidates)
    .slice(0, MAX_SUGGESTIONS)
    .map((candidate) => candidate.name);
}

const Tier = {
  exact: 0,
  exactWithoutNamespace: 1,
  connection: 2,
  namePrefix: 3,
  keyword: 4,
} as const;

function rankCandidate(
  terms: readonly string[],
  scored: readonly string[],
  candidate: RankCandidate,
): { readonly score: number; readonly tier: number } {
  const name =
    candidate.connection === undefined
      ? candidate.name
      : connectionToolName(candidate.connection.name, candidate.name);
  const fullName = tokenize(name);
  const at = name.lastIndexOf("__");
  const localName = tokenize(at < 0 ? name : name.slice(at + 2));
  const tier = sameWords(fullName, terms)
    ? Tier.exact
    : sameWords(localName, terms)
      ? Tier.exactWithoutNamespace
      : candidate.connection !== undefined &&
          startsWithWholeWords(tokenize(candidate.connection.name), terms)
        ? Tier.connection
        : startsWithWords(fullName, terms) || startsWithWords(localName, terms)
          ? Tier.namePrefix
          : Tier.keyword;
  return { score: scoreFields(scored, candidateFields(candidate)), tier };
}

const FILLER_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "is",
  "me",
  "my",
  "of",
  "or",
  "please",
  "the",
  "to",
  "with",
]);

function scoringTerms(terms: readonly string[]): readonly string[] {
  const meaningful = terms.filter((term) => term.length > 1 && !FILLER_WORDS.has(term));
  return meaningful.length > 0 ? meaningful : terms;
}

function sameWords(words: readonly string[], terms: readonly string[]): boolean {
  return words.length === terms.length && startsWithWholeWords(words, terms);
}

function startsWithWholeWords(words: readonly string[], terms: readonly string[]): boolean {
  return terms.length <= words.length && terms.every((term, index) => words[index] === term);
}

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
  const root = (candidate.inputSchema ?? {}) as JsonObject;
  const propertyDescriptions = properties.flatMap(([, schema]) => {
    for (const node of followRefs(root, schema)) {
      if (typeof node.description === "string") return [node.description];
    }
    return [];
  });
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

function tokenize(text: string): string[] {
  return text
    .replaceAll(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word !== "");
}

function proseWords(text: string): string[] {
  return tokenize(text).filter((word) => word.length > 1);
}

export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
