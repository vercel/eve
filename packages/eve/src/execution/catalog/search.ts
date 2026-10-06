/**
 * `search`: finds catalog entries, the agent's deferred tools and every
 * connection tool, by keyword. Its definition is fixed for each eve version,
 * so the catalog can change without changing the model's tool list.
 */

import { isConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { connectionToolName } from "#connections/ownership.js";
import type { AuthorizationSignal } from "#harness/authorization.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createLogger } from "#internal/logging.js";
import { SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import { createAuthorizationExecution } from "#runtime/connections/scoped-authorization.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { ConnectionToolMetadata } from "#shared/connection-types.js";
import { displayProperName } from "#shared/display-name.js";
import { isObject } from "#shared/guards.js";
import { serializeInputSchema, toInputSchema, type ToolSchemaSource } from "#tools/schema.js";

import {
  completePendingAuthorizations,
  findConnection,
  listingFailureMessage,
  resolveInteractiveAuthorization,
  type AuthorizationExecution,
} from "./connection-auth.js";
import { rankCandidates, type RankCandidate } from "./rank.js";
import { connectionToolSignature, entrySignature } from "./signatures.js";

const log = createLogger("framework.catalog-search");

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const SEARCH_DESCRIPTION = [
  "Find more of your own tools, agents, and connected services (MCP servers and OpenAPI APIs) by keyword.",
  "This searches what you can do, not the web.",
  "Returns each match's exact tool name, description, and TypeScript signature; call it with execute.",
  "Omit `query` to list every entry, or pair it with `connection` to list one connection's tools.",
  "Connections the user has not signed in to are listed under `unavailable` with `requiresSignIn`;",
  "when the request needs one, search it again with `connection` and `signIn: true` to ask the user to sign in.",
].join(" ");

const SEARCH_INPUT_SCHEMA = toInputSchema({
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Words describing the capability, such as 'list open issues'. Omit to list every entry.",
    },
    connection: { type: "string", description: "Only search this connection's tools." },
    signIn: {
      type: "boolean",
      description:
        "Ask the user to sign in to `connection` first, then search it. Requires `connection`. Use only for a connection listed with `requiresSignIn` that the request needs.",
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
  readonly connection?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly query?: string;
  readonly signIn?: boolean;
}

interface SearchResult {
  readonly description: string;
  readonly signature: string;
  readonly tool: string;
}

interface UnavailableConnection {
  readonly connection: string;
  readonly error: string;
  /** Present when `signIn: true` can make the connection available. */
  readonly requiresSignIn?: true;
}

interface SearchOutput {
  readonly results: readonly SearchResult[];
  /** Matches across all pages. */
  readonly total: number;
  readonly unavailable?: readonly UnavailableConnection[];
}

/** `signature` renders only for the results a page returns. */
type SearchCandidate = RankCandidate & {
  readonly signature: () => string;
  readonly tool: string;
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
    execute: (rawInput: unknown) =>
      search(input, (isObject(rawInput) ? rawInput : {}) as SearchInput),
    frameworkTool: true,
    inputSchema: SEARCH_INPUT_SCHEMA,
    label: { start: searchLabel },
    name: SEARCH_TOOL_NAME,
  };
}

function searchLabel(input: unknown): string {
  const connection = isObject(input) ? input.connection : undefined;
  if (typeof connection !== "string" || connection === "") return "Search tools";
  return isObject(input) && input.signIn === true
    ? `Connect ${displayProperName(connection)}`
    : `Search ${displayProperName(connection)} tools`;
}

async function search(
  catalog: Parameters<typeof createSearchTool>[0],
  input: SearchInput,
): Promise<SearchOutput | AuthorizationSignal> {
  const connectionName = input.connection === "" ? undefined : input.connection;
  if (input.signIn === true && connectionName === undefined) {
    throw new Error(
      "search with signIn: true requires `connection`. Ask the user to sign in to one connection at a time.",
    );
  }
  const { registry } = catalog;
  const targets = searchedConnections(registry, connectionName);
  const candidates: SearchCandidate[] =
    connectionName === undefined
      ? catalog.deferred.map((definition) => entryCandidate(definition, catalog.describe))
      : [];
  const unavailable: UnavailableConnection[] = [];
  if (registry !== undefined && targets.length > 0) {
    // Finishing a sign-in the user already completed never prompts. Starting one
    // is reserved for `signIn: true` on one named connection and connection calls.
    const auth = createAuthorizationExecution();
    await completePendingAuthorizations(registry, targets, auth);
    for (const connection of targets) {
      const listed = await listConnectionTools(registry, connection, auth, input.signIn === true);
      if ("signIn" in listed) return listed.signIn;
      // Searching one connection reports its failure; searching all lists it.
      if ("failed" in listed && connectionName !== undefined) throw new Error(listed.failed.error);
      if ("tools" in listed) {
        candidates.push(...listed.tools.map((tool) => connectionCandidate(connection, tool)));
      } else {
        unavailable.push("failed" in listed ? listed.failed : listed.unavailable);
      }
    }
  }

  const ranked = rankCandidates(input.query ?? "", candidates);
  const limit = clampInteger(input.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const offset = clampInteger(input.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const output: { -readonly [K in keyof SearchOutput]: SearchOutput[K] } = {
    results: ranked
      .slice(offset, offset + limit)
      .map(({ description, signature, tool }) => ({ description, signature: signature(), tool })),
    total: ranked.length,
  };
  if (unavailable.length > 0) output.unavailable = unavailable;
  return output;
}

function entryCandidate(
  definition: HarnessToolDefinition,
  describe: (definition: HarnessToolDefinition) => string,
): SearchCandidate {
  const inputSchema = serializeInputSchema(definition.inputSchema as ToolSchemaSource);
  return {
    description: describe(definition),
    inputSchema,
    name: definition.name,
    signature: () => entrySignature(definition, inputSchema),
    tool: definition.name,
  };
}

function connectionCandidate(
  connection: ResolvedConnectionDefinition,
  tool: ConnectionToolMetadata,
): SearchCandidate {
  return {
    connection: { description: connection.description, name: connection.connectionName },
    description: tool.description,
    inputSchema: tool.inputSchema,
    name: tool.name,
    signature: () => connectionToolSignature(connection, tool),
    tool: connectionToolName(connection.connectionName, tool.name),
  };
}

type ListedConnectionTools =
  | { readonly tools: readonly ConnectionToolMetadata[] }
  | { readonly signIn: AuthorizationSignal }
  /** Not listable until the user signs in. */
  | { readonly unavailable: UnavailableConnection }
  | { readonly failed: UnavailableConnection };

/** Lists a connection's tools, starting its sign-in instead when `signIn` asks for it. */
async function listConnectionTools(
  registry: ConnectionRegistry,
  connection: ResolvedConnectionDefinition,
  auth: AuthorizationExecution,
  signIn: boolean,
): Promise<ListedConnectionTools> {
  const name = connection.connectionName;
  try {
    return { tools: await registry.getClient(name).getToolMetadata() };
  } catch (error) {
    if (isConnectionAuthorizationRequiredError(error)) {
      const scoped = await resolveInteractiveAuthorization(registry, name);
      // The token the user just signed in with was refused. Asking again would
      // loop, so report the failure instead.
      if (scoped !== undefined && auth.isJustAuthorized(scoped)) {
        return {
          failed: {
            connection: name,
            error: `Authorization failed for "${name}": the service rejected the token immediately after authorization.`,
          },
        };
      }
      if (scoped === undefined) {
        const cannotSignIn = `"${name}" requires authorization and cannot start interactive sign-in.`;
        if (signIn) throw new Error(cannotSignIn);
        return { unavailable: { connection: name, error: cannotSignIn } };
      }
      if (signIn) return { signIn: await auth.handleError(error, scoped) };
      return {
        unavailable: {
          connection: name,
          error:
            `Sign-in required: the user has not signed in to "${name}", so its tools cannot be listed. ` +
            `If the request needs "${name}", call search with connection "${name}" and signIn: true to ask the user to sign in.`,
          requiresSignIn: true,
        },
      };
    }
    log.warn("failed to load connection tools", { connection: name, error });
    return { failed: { connection: name, error: listingFailureMessage(name, error) } };
  }
}

/** The connections a search covers: the named one, or every one. */
function searchedConnections(
  registry: ConnectionRegistry | undefined,
  name: string | undefined,
): readonly ResolvedConnectionDefinition[] {
  if (name === undefined) return registry?.getConnections() ?? [];
  const connection = registry === undefined ? undefined : findConnection(registry, name);
  if (connection !== undefined) return [connection];
  const available = registry?.getConnectionNames() ?? [];
  throw new Error(
    available.length === 0
      ? `Connection "${name}" is not available. No connections are available right now.`
      : `Connection "${name}" is not available. Available connections: ${available.join(", ")}.`,
  );
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
