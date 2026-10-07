/**
 * `search`: finds catalog entries, the agent's deferred tools and every
 * connection tool, by keyword. It never prompts: a connection whose tools need
 * sign-in is found as its sign-in entry instead. Its definition is fixed for
 * each eve version, so the catalog can change without changing the model's
 * tool list.
 */

import { connectionToolName } from "#connections/ownership.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { ConnectionToolMetadata } from "#shared/connection-types.js";
import { isObject } from "#shared/guards.js";
import { serializeInputSchema, toInputSchema, type ToolSchemaSource } from "#tools/schema.js";

import {
  completeConnectionSignIn,
  listConnectionTools,
  listingFailureMessage,
  type ConnectionListing,
} from "./connection-auth.js";
import { connectionSignInEntry } from "./connection-entry.js";
import { rankCandidates, type RankCandidate } from "./rank.js";
import { connectionToolSignature, entrySignature } from "./signatures.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const SEARCH_DESCRIPTION = [
  "Find your own tools, agents, and connected services by keyword; this searches what you can do, not the web.",
  "Returns each match's exact tool name, description, and TypeScript signature, to call with execute.",
  "A connection that needs sign-in appears as a tool named after the connection: executing it asks the user to sign in.",
].join(" ");

const SEARCH_INPUT_SCHEMA = toInputSchema({
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Words describing the capability, such as 'list open issues', or a name or name prefix, such as 'linear'. Omit to list every entry.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `Maximum results. Defaults to ${DEFAULT_LIMIT}.`,
    },
    offset: { type: "integer", minimum: 0, description: "Results to skip, for paging." },
  },
  additionalProperties: false,
});

interface SearchInput {
  readonly limit?: number;
  readonly offset?: number;
  readonly query?: string;
}

interface SearchResult {
  readonly description: string;
  readonly signature: string;
  readonly tool: string;
}

interface UnavailableConnection {
  readonly connection: string;
  readonly error: string;
}

interface SearchOutput {
  readonly results: readonly SearchResult[];
  /** Matches across all pages. */
  readonly total: number;
  readonly unavailable?: readonly UnavailableConnection[];
}

/** `result` renders only for the results a page returns, since signatures cost a render. */
type SearchCandidate = RankCandidate & { readonly result: () => SearchResult };

/**
 * Builds `search` over one step's deferred entries and the connections in
 * `registry`. `describe` returns an entry's description as the model would
 * read it in its tool list.
 */
export function createSearchTool(input: {
  readonly deferred: readonly HarnessToolDefinition[];
  readonly describe: (definition: HarnessToolDefinition) => string;
  readonly registry: ConnectionRegistry | undefined;
}): HarnessToolDefinition {
  return {
    description: SEARCH_DESCRIPTION,
    execute: (rawInput: unknown) =>
      search(input, (isObject(rawInput) ? rawInput : {}) as SearchInput),
    frameworkTool: true,
    inputSchema: SEARCH_INPUT_SCHEMA,
    label: { start: () => "Search tools" },
    name: SEARCH_TOOL_NAME,
  };
}

async function search(
  catalog: Parameters<typeof createSearchTool>[0],
  input: SearchInput,
): Promise<SearchOutput> {
  const candidates = catalog.deferred.map((definition) =>
    entryCandidate(definition, catalog.describe),
  );
  const unavailable: UnavailableConnection[] = [];
  const { registry } = catalog;
  if (registry !== undefined) {
    for (const connection of registry.getConnections()) {
      const found = await searchConnection(registry, connection);
      if ("unavailable" in found) unavailable.push(found.unavailable);
      else candidates.push(...found.candidates);
    }
  }

  const ranked = rankCandidates(input.query ?? "", candidates);
  const limit = clampInteger(input.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const offset = clampInteger(input.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const output: { -readonly [K in keyof SearchOutput]: SearchOutput[K] } = {
    results: ranked.slice(offset, offset + limit).map((candidate) => candidate.result()),
    total: ranked.length,
  };
  if (unavailable.length > 0) output.unavailable = unavailable;
  return output;
}

/** A connection's tools, or its sign-in entry while listing them needs sign-in. */
async function searchConnection(
  registry: ConnectionRegistry,
  connection: ResolvedConnectionDefinition,
): Promise<
  | { readonly candidates: readonly SearchCandidate[] }
  | { readonly unavailable: UnavailableConnection }
> {
  const name = connection.connectionName;
  let listing: ConnectionListing;
  try {
    listing = await listConnectionTools(
      connection,
      await completeConnectionSignIn(registry, connection),
    );
  } catch (error) {
    return { unavailable: { connection: name, error: listingFailureMessage(name, error) } };
  }
  if ("failure" in listing) return { unavailable: { connection: name, error: listing.failure } };
  if ("authorization" in listing) return { candidates: [signInCandidate(registry, connection)] };
  return { candidates: listing.tools.map((tool) => toolCandidate(connection, tool)) };
}

function entryCandidate(
  definition: HarnessToolDefinition,
  describe: (definition: HarnessToolDefinition) => string,
): SearchCandidate {
  const inputSchema = serializeInputSchema(definition.inputSchema as ToolSchemaSource);
  const description = describe(definition);
  return {
    description,
    inputSchema,
    name: definition.name,
    result: () => ({
      description,
      signature: entrySignature(definition, inputSchema),
      tool: definition.name,
    }),
  };
}

function toolCandidate(
  connection: ResolvedConnectionDefinition,
  tool: ConnectionToolMetadata,
): SearchCandidate {
  return {
    connection: { description: connection.description, name: connection.connectionName },
    description: tool.description,
    inputSchema: tool.inputSchema,
    name: tool.name,
    result: () => ({
      description: tool.description,
      signature: connectionToolSignature(connection, tool),
      tool: connectionToolName(connection.connectionName, tool.name),
    }),
  };
}

/** Found by the connection's own name and description, as its sign-in entry. */
function signInCandidate(
  registry: ConnectionRegistry,
  connection: ResolvedConnectionDefinition,
): SearchCandidate {
  const entry = connectionSignInEntry(registry, connection);
  return {
    description: connection.description,
    name: connection.connectionName,
    result: () => ({
      description: entry.description,
      signature: entrySignature(entry),
      tool: entry.name,
    }),
  };
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
