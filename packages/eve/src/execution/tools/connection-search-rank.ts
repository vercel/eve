/**
 * Keyword ranking for `connection_search` and for `connection_execute`'s
 * suggestions when a tool name is unknown. Query and field text split into
 * lowercase words (camelCase and punctuation are boundaries); a query word
 * matches a field word when either is a prefix of the other, so `repo` finds
 * `repositories` and `issues` finds `issue`. Each query word adds the weight of
 * every field it matches, so broad fields rank below a tool's own name.
 */

import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { ConnectionToolMetadata } from "#shared/connection-types.js";
import { isObject } from "#shared/guards.js";

export interface RankCandidate {
  readonly connection: Pick<ResolvedConnectionDefinition, "connectionName" | "description">;
  readonly tool: ConnectionToolMetadata;
}

/** Candidates matching `query`, best first. An empty query matches every candidate. */
export function rankConnectionTools<T extends RankCandidate>(
  query: string,
  candidates: readonly T[],
): T[] {
  const terms = tokenize(query);
  return candidates
    .map((candidate) => ({
      candidate,
      score:
        terms.length === 0
          ? 1
          : scoreFields(terms, [
              ...toolFields(candidate.tool),
              [tokenize(candidate.connection.connectionName), 4],
              [tokenize(candidate.connection.description), 1],
            ]),
    }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.candidate.connection.connectionName.localeCompare(
          b.candidate.connection.connectionName,
        ) ||
        a.candidate.tool.name.localeCompare(b.candidate.tool.name),
    )
    .map((entry) => entry.candidate);
}

/**
 * Names of one connection's tools closest to an unknown `name`. Only the tools'
 * own fields count, since every candidate shares the connection.
 */
export function closestToolNames(
  name: string,
  tools: readonly ConnectionToolMetadata[],
  limit: number,
): string[] {
  const terms = tokenize(name);
  if (terms.length === 0) return [];
  return tools
    .map((tool) => ({ name: tool.name, score: scoreFields(terms, toolFields(tool)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => entry.name);
}

type Field = readonly [words: readonly string[], weight: number];

function toolFields(tool: ConnectionToolMetadata): Field[] {
  const properties = isObject(tool.inputSchema.properties)
    ? Object.entries(tool.inputSchema.properties)
    : [];
  const propertyDescriptions = properties.flatMap(([, schema]) =>
    isObject(schema) && typeof schema.description === "string" ? [schema.description] : [],
  );
  return [
    [tokenize(tool.name), 6],
    [properties.flatMap(([key]) => tokenize(key)), 3],
    [tokenize(tool.description), 2],
    [propertyDescriptions.flatMap(tokenize), 1],
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
