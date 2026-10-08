/**
 * `eve__search`: finds catalog entries, the agent's deferred tools and skills
 * and every connection tool, by keyword. It never prompts: a connection whose
 * tools need sign-in is found as its sign-in entry instead. Its definition is
 * fixed for each eve version, so the catalog can change without changing the model's
 * tool list.
 */

import { connectionToolName } from "#connections/ownership.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { EXECUTE_TOOL_NAME, SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";
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
import { closestNames, isEmptyQuery, rankCandidates, type RankCandidate } from "./rank.js";
import { connectionToolSignature, entrySignature } from "./signatures.js";
import type { CatalogSkill } from "./skills.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const SEARCH_DESCRIPTION = [
  "Find your own tools, agents, skills, and connected services by keyword; this searches what you can do, not the web.",
  `Returns each tool's exact name, description, and TypeScript signature, to call with ${EXECUTE_TOOL_NAME}({ tool, input }),`,
  `and each skill's name and description, to load with ${EXECUTE_TOOL_NAME}({ skill }).`,
  'When you already know a name or connection, from the catalog listing, an earlier result, or an error, search it directly: the exact name, or "<connection>__", which is faster and returns only that connection\'s tools.',
  `A connection that needs sign-in appears as a tool named after the connection: calling it with ${EXECUTE_TOOL_NAME} asks the user to sign in.`,
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
  /** The schema requires it; a call that skips validation and omits it fails like a query with no words. */
  readonly query?: string;
}

type SearchResult =
  | { readonly description: string; readonly signature: string; readonly tool: string }
  | { readonly description: string; readonly path?: string; readonly skill: string };

interface UnavailableConnection {
  readonly connection: string;
  readonly error: string;
}

interface SearchOutput {
  readonly results: readonly SearchResult[];
  readonly unavailable?: readonly UnavailableConnection[];
}

/**
 * `fullName` is the name `eve__execute` takes and a namespace query scopes. `result`
 * renders only for the results returned, since signatures cost a render.
 */
type SearchCandidate = RankCandidate & {
  readonly fullName: string;
  readonly result: () => SearchResult;
};

/** People see what the model searched for and, once it returns, how much it found. */
const SEARCH_LABEL = {
  start: (input: unknown) => `Search tools${labelQuery(input)}`,
  complete: (input: unknown, output: unknown) => {
    const { results, unavailable = [] } = output as SearchOutput;
    const searched = `Searched tools${labelQuery(input)}, found ${results.length === 0 ? "nothing" : String(results.length)}`;
    if (results.length > 0 || unavailable.length === 0) return searched;
    const connections = unavailable.length === 1 ? "connection" : "connections";
    return `${searched}; ${String(unavailable.length)} ${connections} unavailable`;
  },
};

function labelQuery(input: unknown): string {
  const query = (input as SearchInput).query?.trim();
  return query ? ` for “${query}”` : "";
}

/**
 * Builds `eve__search` over one step's deferred entries and skills and the
 * connections in `registry`. `describe` returns an entry's description as the
 * model would read it in its tool list.
 */
export function createSearchTool(input: {
  readonly deferred: readonly HarnessToolDefinition[];
  readonly describe: (definition: HarnessToolDefinition) => string;
  readonly registry: ConnectionRegistry | undefined;
  readonly skills: readonly CatalogSkill[];
}): HarnessToolDefinition {
  return {
    description: SEARCH_DESCRIPTION,
    execute: (rawInput: unknown) => search(input, rawInput as SearchInput),
    frameworkTool: true,
    inputSchema: SEARCH_INPUT_SCHEMA,
    label: SEARCH_LABEL,
    name: SEARCH_TOOL_NAME,
  };
}

async function search(
  catalog: Parameters<typeof createSearchTool>[0],
  input: SearchInput,
): Promise<SearchOutput> {
  const query = input.query ?? "";
  if (isEmptyQuery(query)) {
    throw new Error(
      `${SEARCH_TOOL_NAME} needs at least one word in query, such as a capability ("list open issues") or a name or connection prefix ("linear__").`,
    );
  }
  const namespace = parseNamespace(query);
  const inScope = (name: string) => namespace === undefined || inNamespace(name, namespace);

  const candidates: SearchCandidate[] = [
    ...catalog.deferred.map((definition) => entryCandidate(definition, catalog.describe)),
    ...catalog.skills.map(skillCandidate),
  ].filter((candidate) => inScope(candidate.fullName));
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

  if (namespace !== undefined && candidates.length === 0 && unavailable.length === 0) {
    throw new Error(unknownNamespaceMessage(namespace, registry?.getConnections() ?? []));
  }

  const limit = clampInteger(input.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const results = rankCandidates(query, candidates)
    .slice(0, limit)
    .map((candidate) => candidate.result());
  return unavailable.length > 0 ? { results, unavailable } : { results };
}

/**
 * The namespace a query scopes to: when its first word contains `__`,
 * everything before its last `__`, without trailing underscores. It only
 * filters; the whole query still ranks. Characters that can't appear in a
 * name, such as a leading `^`, are ignored; regex isn't supported.
 */
function parseNamespace(query: string): string | undefined {
  const word = (query.trim().split(/\s+/u)[0] ?? "").replace(/^[^A-Za-z0-9_-]+/u, "");
  const namespace = word.slice(0, Math.max(0, word.lastIndexOf("__"))).replace(/_+$/u, "");
  return namespace === "" ? undefined : namespace;
}

/**
 * Names under `<namespace>__`, plus anything named exactly `namespace`, such
 * as a connection's sign-in entry.
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

/**
 * Why a namespace query found nothing: the connection it names has no tools,
 * or the closest connection names, or how to find names when none is close.
 * Names are case-sensitive, so `Linear__` misses `linear`.
 */
function unknownNamespaceMessage(
  namespace: string,
  connections: readonly ResolvedConnectionDefinition[],
): string {
  // A connection that lists no tools, such as an empty server or one its tool filter empties.
  if (connections.some(({ connectionName }) => connectionName === namespace)) {
    return `Connection "${namespace}" has no tools.`;
  }
  const closest = closestNames(
    namespace,
    connections.map(({ connectionName, description }) => ({
      description,
      name: connectionName,
    })),
  );
  const hint =
    closest.length > 0
      ? `Closest connections: ${closest.join(", ")}.`
      : `Find names in the catalog listing or your tool list, or call ${SEARCH_TOOL_NAME} with plain words.`;
  return `No entries are named "${namespace}__…". ${hint}`;
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

function skillCandidate({ description, name, path }: CatalogSkill): SearchCandidate {
  return {
    description,
    fullName: name,
    name,
    result: () => ({ description, path, skill: name }),
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
