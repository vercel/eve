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
import { serializeInputSchema, toInputSchema, type ToolSchemaSource } from "#tools/schema.js";

import {
  completeConnectionSignIn,
  listConnectionTools,
  listingFailureMessage,
  type ConnectionListing,
} from "./connection-auth.js";
import { connectionSignInEntry } from "./connection-entry.js";
import { isEmptyQuery, rankCandidates, type RankCandidate } from "./rank.js";
import { connectionToolSignature, entrySignature } from "./signatures.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const SEARCH_DESCRIPTION = [
  "Find your own tools, agents, and connected services by keyword; this searches what you can do, not the web.",
  "Returns each match's exact tool name, description, and TypeScript signature, to call with execute.",
  'When you already know a name or connection, from the catalog listing, an earlier result, or an error, search it directly: the exact name, or "<connection>__" for one connection\'s tools, which is faster and returns only that connection.',
  "A connection that needs sign-in appears as a tool named after the connection: executing it asks the user to sign in.",
].join(" ");

const SEARCH_INPUT_SCHEMA = toInputSchema({
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      description:
        "Words describing the capability, such as 'list open issues'; an exact name; or a namespace prefix such as 'linear__', which searches only that connection's tools.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `Maximum results, best matches first. Defaults to ${DEFAULT_LIMIT}.`,
    },
  },
  required: ["query"],
  additionalProperties: false,
});

interface SearchInput {
  readonly limit?: number;
  readonly query: string;
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
  readonly unavailable?: readonly UnavailableConnection[];
}

/**
 * `fullName` is the name `execute` takes and a namespace query scopes. `result`
 * renders only for the results returned, since signatures cost a render.
 */
type SearchCandidate = RankCandidate & {
  readonly fullName: string;
  readonly result: () => SearchResult;
};

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
    // The SDK validates input against the schema before execute runs.
    execute: (rawInput: unknown) => search(input, rawInput as SearchInput),
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
  const { namespace, words } = parseQuery(input.query);
  if (namespace === undefined && isEmptyQuery(words)) {
    throw new Error(
      'search needs at least one word in query, such as a capability ("list open issues") or a name or connection prefix ("linear__").',
    );
  }
  const inScope = (name: string) => namespace === undefined || inNamespace(name, namespace);

  const candidates = catalog.deferred
    .map((definition) => entryCandidate(definition, catalog.describe))
    .filter((candidate) => inScope(candidate.fullName));
  const unavailable: UnavailableConnection[] = [];
  const { registry } = catalog;
  if (registry !== undefined) {
    const connections = registry
      .getConnections()
      .filter(
        ({ connectionName }) =>
          namespace === undefined || mayOwnNamespace(connectionName, namespace),
      );
    const found = await Promise.all(
      connections.map((connection) => searchConnection(registry, connection)),
    );
    for (const connection of found) {
      if ("unavailable" in connection) unavailable.push(connection.unavailable);
      else
        candidates.push(
          ...connection.candidates.filter((candidate) => inScope(candidate.fullName)),
        );
    }
  }

  const limit = clampInteger(input.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const results = rankCandidates(words, candidates)
    .slice(0, limit)
    .map((candidate) => candidate.result());
  return unavailable.length > 0 ? { results, unavailable } : { results };
}

/**
 * Splits off a namespace: when the query's first word contains `__`,
 * everything before its last `__` scopes the search, and the rest of the
 * query is ranked within it. Characters that can't appear in a name, such as
 * a leading `^`, are ignored; regex isn't supported.
 */
function parseQuery(query: string): { readonly namespace?: string; readonly words: string } {
  const [first = "", ...rest] = query.trim().split(/\s+/u);
  const word = first.replace(/^[^A-Za-z0-9_-]+/u, "");
  const separator = word.lastIndexOf("__");
  if (separator <= 0) return { words: query };
  return {
    namespace: word.slice(0, separator),
    words: [word.slice(separator + 2), ...rest].join(" "),
  };
}

/**
 * Whether `name` is in `namespace`: under its `<namespace>__` prefix, or the
 * namespace itself. A connection owns its name and every name under its
 * prefix, so when the namespace is a connection, the one entry named exactly
 * the namespace is that connection's sign-in entry.
 */
function inNamespace(name: string, namespace: string): boolean {
  return name === namespace || name.startsWith(`${namespace}__`);
}

/**
 * Whether a connection can own names in `namespace`. Its names are its own
 * and those under its prefix, so only a connection that is the namespace,
 * contains it, or sits under it (an extension's connection, such as
 * `crm__api` under `crm`) can; every other connection is skipped without
 * listing its tools.
 */
function mayOwnNamespace(connectionName: string, namespace: string): boolean {
  return inNamespace(connectionName, namespace) || namespace.startsWith(`${connectionName}__`);
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
    fullName: definition.name,
  };
}

function toolCandidate(
  connection: ResolvedConnectionDefinition,
  tool: ConnectionToolMetadata,
): SearchCandidate {
  const name = connectionToolName(connection.connectionName, tool.name);
  return {
    connection: { description: connection.description, name: connection.connectionName },
    description: tool.description,
    inputSchema: tool.inputSchema,
    name: tool.name,
    result: () => ({
      description: tool.description,
      signature: connectionToolSignature(connection, tool),
      tool: name,
    }),
    fullName: name,
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
    fullName: entry.name,
  };
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
