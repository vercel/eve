import { isConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { connectionToolName } from "#connections/ownership.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { CALL_TOOL_NAME, SEARCH_TOOL_NAME, SKILL_TOOL_NAME } from "#protocol/catalog-tools.js";
import { SUBSCRIBE_TOOL } from "#runtime/subscriptions/tools.js";
import type { ChannelEventDefinition } from "#shared/channel-subscriptions.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { ConnectionToolMetadata } from "#shared/connection-types.js";
import { serializeInputSchema, toInputSchema, type ToolSchemaSource } from "#tools/schema.js";
import { renderToolSignature } from "#tools/signature.js";

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
import type { SubscriptionSources } from "./subscription-tools.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export interface SearchReach {
  readonly connections: boolean;
  readonly skills: boolean;
  readonly subscriptions: boolean;
  readonly tools: boolean;
}

function searchDescription({ connections, skills, subscriptions, tools }: SearchReach): string {
  return [
    "Search your own catalog for tools, agents, skills, and connected services that aren't in your tool list. Use it when nothing in your tool list fits the request; it doesn't search the web.",
    tools
      ? `A result with \`tool\` has the exact name, description, and TypeScript signature: call it with ${CALL_TOOL_NAME}({ name, input }).`
      : undefined,
    skills
      ? `A result with \`skill\` has the name and description: load it with ${SKILL_TOOL_NAME}({ name }).`
      : undefined,
    subscriptions
      ? `A result with \`event\` is an event you can subscribe to: it has the \`source\`, the exact event name, and the signature of the ${SUBSCRIBE_TOOL} call. Find them with the prefix "subscriptions__<source>__" or with words such as "github check suite".`
      : undefined,
    "`searched` counts the entries the query covered, and `remaining` counts the matches past `limit`: when `remaining` is 0, nothing else the query covered matched. Connections under `unavailable` weren't searched.",
    'When you already know a name or connection, from the catalog listing, an earlier result, or an error, search it directly: the exact name, or "<connection>__", which is faster and returns only that connection\'s tools.',
    connections
      ? `A connection that needs sign-in appears as a tool named after the connection: calling it with ${CALL_TOOL_NAME}({ name }) asks the user to sign in. \`searched\` counts its tools only after sign-in.`
      : undefined,
  ]
    .filter((sentence) => sentence !== undefined)
    .join(" ");
}

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
  readonly query?: string;
}

type SearchResult =
  | { readonly description: string; readonly signature: string; readonly tool: string }
  | { readonly description: string; readonly path?: string; readonly skill: string }
  | {
      readonly description: string;
      readonly event: string;
      readonly signature: string;
      readonly source: string;
    };

interface UnavailableConnection {
  readonly connection: string;
  readonly error: string;
}

interface SearchOutput {
  readonly results: readonly SearchResult[];
  readonly remaining: number;
  readonly searched: number;
  readonly unavailable?: readonly UnavailableConnection[];
}

type SearchCandidate = RankCandidate & {
  readonly fullName: string;
  readonly result: () => SearchResult;
};

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

export function createSearchTool(input: {
  readonly deferred: readonly HarnessToolDefinition[];
  readonly describe: (definition: HarnessToolDefinition) => string;
  readonly reach: SearchReach;
  readonly registry: ConnectionRegistry | undefined;
  readonly skills: readonly CatalogSkill[];
  readonly subscriptions: SubscriptionSources;
}): HarnessToolDefinition {
  return {
    description: searchDescription(input.reach),
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
    ...catalog.subscriptions.channels.flatMap(({ channelName, events }) =>
      (events ?? []).map((event) => subscriptionCandidate(channelName, "channel", event)),
    ),
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

  if (registry !== undefined) {
    const sources = catalog.subscriptions.connections.filter(
      ({ connectionName }) =>
        namespace === undefined || mayOwnNamespace(subscriptionName(connectionName), namespace),
    );
    const found = await Promise.all(
      sources.map((connection) => searchConnectionEvents(registry, connection)),
    );
    for (const connection of found) {
      if ("unavailable" in connection) {
        if (!unavailable.some(({ connection: name }) => name === connection.unavailable.connection))
          unavailable.push(connection.unavailable);
      } else {
        const known = new Set(candidates.map(({ fullName }) => fullName));
        candidates.push(
          ...connection.candidates.filter(
            (candidate) =>
              !known.has(candidate.fullName) &&
              (connection.signIn === candidate || inScope(candidate.fullName)),
          ),
        );
      }
    }
  }

  if (namespace !== undefined && candidates.length === 0 && unavailable.length === 0) {
    throw new Error(unknownNamespaceMessage(namespace, registry?.getConnections() ?? []));
  }

  const limit = clampInteger(input.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const matches = rankCandidates(query, candidates);
  const results = matches.slice(0, limit).map((candidate) => candidate.result());
  const found = {
    results,
    remaining: matches.length - results.length,
    searched: candidates.length,
  };
  return unavailable.length > 0 ? { ...found, unavailable } : found;
}

function parseNamespace(query: string): string | undefined {
  const word = (query.trim().split(/\s+/u)[0] ?? "").replace(/^[^A-Za-z0-9_-]+/u, "");
  const namespace = word.slice(0, Math.max(0, word.lastIndexOf("__"))).replace(/_+$/u, "");
  return namespace === "" ? undefined : namespace;
}

function inNamespace(name: string, namespace: string): boolean {
  return name === namespace || name.startsWith(`${namespace}__`);
}

function mayOwnNamespace(connectionName: string, namespace: string): boolean {
  return inNamespace(connectionName, namespace) || namespace.startsWith(`${connectionName}__`);
}

function unknownNamespaceMessage(
  namespace: string,
  connections: readonly ResolvedConnectionDefinition[],
): string {
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

async function searchConnectionEvents(
  registry: ConnectionRegistry,
  connection: ResolvedConnectionDefinition,
): Promise<
  | { readonly candidates: readonly SearchCandidate[]; readonly signIn?: SearchCandidate }
  | { readonly unavailable: UnavailableConnection }
> {
  const name = connection.connectionName;
  try {
    await completeConnectionSignIn(registry, connection);
    const events = (await registry.getClient(name).eventActions?.list()) ?? [];
    return {
      candidates: events.map((event) => subscriptionCandidate(name, "connection", event)),
    };
  } catch (error) {
    if (isConnectionAuthorizationRequiredError(error)) {
      const signIn = signInCandidate(registry, connection);
      return { candidates: [signIn], signIn };
    }
    return { unavailable: { connection: name, error: listingFailureMessage(name, error) } };
  }
}

function subscriptionName(source: string): string {
  return `subscriptions__${source}`;
}

function subscriptionCandidate(
  source: string,
  kind: "channel" | "connection",
  event: ChannelEventDefinition,
): SearchCandidate {
  const description =
    event.description === "" ? `A ${kind} event of ${source}.` : event.description;
  return {
    connection: { description: `Events from the ${source} ${kind}.`, name: source },
    description,
    inputSchema: event.inputSchema,
    name: event.name,
    result: () => ({
      description,
      event: event.name,
      signature: renderToolSignature({
        name: SUBSCRIBE_TOOL,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["source", "event", "input", "ttlMs"],
          properties: {
            source: { const: source },
            event: { const: event.name },
            input: event.inputSchema,
            ttlMs: { type: ["integer", "null"] },
          },
        },
      }),
      source,
    }),
    fullName: `${subscriptionName(source)}__${event.name}`,
  };
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
