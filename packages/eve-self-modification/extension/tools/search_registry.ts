import { defineTool, type ToolContext } from "eve/tools";

/** Registry categories an integration search can be narrowed to. */
const CATEGORIES = ["channel", "connection", "extension", "instrumentation"] as const;

type Category = (typeof CATEGORIES)[number];

const DEFAULT_REGISTRY_BASE = "https://eve.dev/r";
const INDEX_PATH = "/registry.json";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const MIN_RELATIVE_SCORE = 0.4;
const FETCH_TIMEOUT_MS = 10_000;
/**
 * The catalog changes when eve releases, not between turns, so one fetch can
 * serve a whole conversation. A stale-tolerant read is correct here.
 */
const CACHE_TTL_MS = 5 * 60_000;
/** The sandbox mounts the authored `agent/` directory here in development. */
const AUTHORED_SOURCE_MOUNT = "/source";
const AUTHORED_PREFIX = "agent/";

const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      maxLength: 200,
      description: "Free-text match against integration names, titles, and descriptions.",
    },
    category: {
      type: "string",
      enum: [...CATEGORIES],
      description: "Restrict results to one registry category.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `Maximum number of items to return (default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}).`,
    },
    offset: {
      type: "integer",
      minimum: 0,
      description:
        "Number of matching items to skip. Use nextOffset from a prior result to retrieve the next page.",
    },
  },
} as const;

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          address: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          category: { type: "string" },
          components: { type: "array", items: { type: "string" } },
          requires: { type: "string" },
          installed: { type: "boolean" },
        },
        required: ["address", "title"],
      },
    },
    errors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          registry: { type: "string" },
          message: { type: "string" },
        },
        required: ["registry", "message"],
      },
    },
    total: { type: "integer" },
    hasMore: { type: "boolean" },
    nextOffset: { type: "integer" },
  },
  required: ["items", "errors", "total", "hasMore"],
} as const;

/** One catalog entry, narrowed from the published registry index. */
export interface CatalogEntry {
  readonly address: string;
  readonly title: string;
  readonly description?: string;
  readonly category?: Category;
  readonly components?: readonly string[];
  /** Component addresses, labels, and descriptions used to search bundles. */
  readonly componentSearchTerms?: readonly string[];
  readonly requires?: string;
  /** Authored path this item installs, used to detect an existing install. */
  readonly authoredTarget?: string;
  /** Whether `meta.eve.setup` declares one or more setup commands. */
  readonly declaresSetup?: boolean;
  /** Names of environment variables the item declares. */
  readonly envVars?: readonly string[];
}

/** One row returned to the model. */
export interface FoundIntegration {
  readonly address: string;
  readonly title: string;
  readonly description?: string;
  readonly category?: Category;
  readonly components?: readonly string[];
  readonly requires?: string;
  readonly installed?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

/**
 * Derives the category from the item address.
 *
 * eve registry addresses carry their category as the leading path segment.
 * Bundles (`linear`) and package-scoped items (`experimental/self-modification`)
 * have none, so the field stays absent rather than being guessed.
 */
function categoryOf(address: string): Category | undefined {
  const segment = address.split("/")[0];
  return segment !== undefined && address.includes("/") && isCategory(segment)
    ? segment
    : undefined;
}

/**
 * Falls back to a readable title for an item that publishes none, matching how
 * the eve CLI labels catalog rows.
 */
function titleFromAddress(address: string): string {
  const slug = address.split("/").at(-1) ?? address;
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Reads the eve-owned metadata block from one index entry.
 *
 * `meta.eve` is eve's own registry contract, described by the schemas in the
 * CLI's `registry-metadata.ts`. This reads the two fields the subagent needs
 * and ignores the rest, so an added field degrades to an absent value here
 * instead of a parse failure.
 */
function eveMetadata(entry: Record<string, unknown>): Record<string, unknown> {
  const meta = entry.meta;
  if (!isRecord(meta)) return {};
  const eve = meta.eve;
  return isRecord(eve) ? eve : {};
}

/** Metadata for bundle components, used both for display and free-text search. */
function componentMetadata(
  eve: Record<string, unknown>,
): { readonly addresses: readonly string[]; readonly searchTerms: readonly string[] } | undefined {
  const components = eve.components;
  if (!Array.isArray(components)) return undefined;

  const addresses: string[] = [];
  const searchTerms: string[] = [];
  for (const component of components) {
    if (!isRecord(component)) continue;
    const address = optionalString(component.item);
    if (address === undefined) continue;
    addresses.push(address);
    searchTerms.push(address);
    const label = optionalString(component.label);
    if (label !== undefined) searchTerms.push(label);
    const description = optionalString(component.description);
    if (description !== undefined) searchTerms.push(description);
  }
  return addresses.length > 0 ? { addresses, searchTerms } : undefined;
}

/** First authored file the item installs; identifies an existing install. */
function authoredTargetOf(entry: Record<string, unknown>): string | undefined {
  const files = entry.files;
  if (!Array.isArray(files)) return undefined;
  for (const file of files) {
    if (!isRecord(file)) continue;
    const target = optionalString(file.target);
    if (target?.startsWith(AUTHORED_PREFIX) === true) return target;
  }
  return undefined;
}

/** Names of environment variables the item declares, used to report unset ones after install. */
function declaredEnvVars(entry: Record<string, unknown>): readonly string[] {
  const envVars = entry.envVars;
  return isRecord(envVars) ? Object.keys(envVars) : [];
}

/**
 * Narrows the published registry index into catalog entries.
 *
 * Unreadable entries are skipped rather than failing the whole search: the
 * index is owned by the registry and may carry fields this version predates.
 */
export function parseRegistryIndex(value: unknown): readonly CatalogEntry[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return [];
  const entries: CatalogEntry[] = [];

  for (const item of value.items) {
    if (!isRecord(item)) continue;
    const address = optionalString(item.name);
    if (address === undefined) continue;
    const eve = eveMetadata(item);

    const entry: {
      address: string;
      authoredTarget?: string;
      category?: Category;
      componentSearchTerms?: readonly string[];
      components?: readonly string[];
      declaresSetup?: boolean;
      description?: string;
      envVars?: readonly string[];
      requires?: string;
      title: string;
    } = { address, title: optionalString(item.title) ?? titleFromAddress(address) };

    const category = categoryOf(address);
    if (category !== undefined) entry.category = category;
    const description = optionalString(item.description);
    if (description !== undefined) entry.description = description;
    const components = componentMetadata(eve);
    if (components !== undefined) {
      entry.components = components.addresses;
      entry.componentSearchTerms = components.searchTerms;
    }
    const requires = optionalString(eve.requires);
    if (requires !== undefined) entry.requires = requires;
    const authoredTarget = authoredTargetOf(item);
    if (authoredTarget !== undefined) entry.authoredTarget = authoredTarget;
    if (eve.setup !== undefined && eve.setup !== null) entry.declaresSetup = true;
    const envVars = declaredEnvVars(item);
    if (envVars.length > 0) entry.envVars = envVars;

    entries.push(entry);
  }

  return entries;
}

/**
 * Filters and bounds catalog entries for one search.
 *
 * A bundle matches when one of its components matches the requested category,
 * so asking for channels still surfaces `linear` (which installs a channel)
 * instead of hiding it behind its uncategorized address.
 */
export function selectIntegrations(input: {
  readonly category?: Category;
  readonly entries: readonly CatalogEntry[];
  readonly limit?: number;
  readonly query?: string;
}): readonly FoundIntegration[] {
  return selectIntegrationPage(input).items;
}

export function selectIntegrationPage(input: {
  readonly category?: Category;
  readonly entries: readonly CatalogEntry[];
  readonly limit?: number;
  readonly offset?: number;
  readonly query?: string;
}): {
  readonly hasMore: boolean;
  readonly items: readonly FoundIntegration[];
  readonly nextOffset?: number;
  readonly total: number;
} {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(input.offset ?? 0, 0);
  const terms = (input.query ?? "")
    .toLowerCase()
    .split(/\s+/u)
    .filter((term) => term.length > 0);

  const searchableEntries = input.entries.map((entry, index) => {
    const primaryTerms = `${entry.address} ${entry.title}`.toLowerCase();
    return {
      entry,
      haystack: [
        primaryTerms,
        entry.description ?? "",
        ...(entry.componentSearchTerms ?? entry.components ?? []),
      ]
        .join(" ")
        .toLowerCase(),
      index,
      primaryTerms,
    };
  });
  const termWeights = new Map(
    terms.map((term) => {
      const documentFrequency = searchableEntries.filter(({ haystack }) =>
        haystack.includes(term),
      ).length;
      return [term, Math.log((searchableEntries.length + 1) / (documentFrequency + 1)) + 1];
    }),
  );
  const rankedMatches = searchableEntries
    .map(({ entry, haystack, index, primaryTerms }) => {
      if (input.category !== undefined && !matchesCategory(entry, input.category)) return undefined;
      if (terms.length === 0) return { entry, index, score: 0 };
      const score = terms.reduce((total, term) => {
        const weight = termWeights.get(term) ?? 0;
        if (primaryTerms.includes(term)) return total + 2 * weight;
        return haystack.includes(term) ? total + weight : total;
      }, 0);
      return score > 0 ? { entry, index, score } : undefined;
    })
    .filter(
      (match): match is { entry: CatalogEntry; index: number; score: number } =>
        match !== undefined,
    )
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const minimumScore = (rankedMatches[0]?.score ?? 0) * MIN_RELATIVE_SCORE;
  const matches = rankedMatches.filter(({ score }) => score >= minimumScore);

  const items = matches.slice(offset, offset + limit).map(({ entry }) => {
    const row: {
      address: string;
      category?: Category;
      components?: readonly string[];
      description?: string;
      requires?: string;
      title: string;
    } = { address: entry.address, title: entry.title };
    if (entry.category !== undefined) row.category = entry.category;
    if (entry.components !== undefined) row.components = entry.components;
    if (entry.description !== undefined) row.description = entry.description;
    if (entry.requires !== undefined) row.requires = entry.requires;
    return row;
  });
  const nextOffset = offset + items.length;
  const result: {
    hasMore: boolean;
    items: readonly FoundIntegration[];
    nextOffset?: number;
    total: number;
  } = {
    hasMore: nextOffset < matches.length,
    items,
    total: matches.length,
  };
  if (nextOffset < matches.length) result.nextOffset = nextOffset;
  return result;
}

function matchesCategory(entry: CatalogEntry, category: Category): boolean {
  if (entry.category === category) return true;
  return entry.components?.some((component) => categoryOf(component) === category) === true;
}

/**
 * Resolves the registry index URL, honoring the same development override the
 * eve CLI reads.
 *
 * The override decides which registry the agent trusts, so it enforces the same
 * rules as `resolveOfficialRegistryUrl` in eve's registry command: HTTP(S) only,
 * no embedded credentials, no query or fragment. The rules are restated here
 * rather than imported because that module reaches the registry client, which
 * has no place in an agent runtime.
 */
export function resolveRegistryIndexUrl(configured = process.env.EVE_DEV_OFFICIAL_REGISTRY_URL) {
  if (configured === undefined) return `${DEFAULT_REGISTRY_BASE}${INDEX_PATH}`;

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("EVE_DEV_OFFICIAL_REGISTRY_URL must be an HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("EVE_DEV_OFFICIAL_REGISTRY_URL must be an HTTP(S) URL.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("EVE_DEV_OFFICIAL_REGISTRY_URL must not include credentials.");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("EVE_DEV_OFFICIAL_REGISTRY_URL must not include a query or fragment.");
  }

  url.pathname = `${url.pathname.replace(/\/+$/u, "")}${INDEX_PATH}`;
  return url.toString();
}

interface CachedIndex {
  readonly entries: readonly CatalogEntry[];
  readonly fetchedAtMs: number;
  readonly url: string;
}

let cache: CachedIndex | undefined;

/** Clears the module-level index cache. Test seam. */
export function clearRegistryIndexCache(): void {
  cache = undefined;
}

export async function loadRegistryIndex(input: {
  readonly nowMs: number;
  readonly signal?: AbortSignal;
  readonly url: string;
}): Promise<readonly CatalogEntry[]> {
  if (
    cache !== undefined &&
    cache.url === input.url &&
    input.nowMs - cache.fetchedAtMs < CACHE_TTL_MS
  ) {
    return cache.entries;
  }

  const response = await fetch(input.url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.any(
      input.signal === undefined
        ? [AbortSignal.timeout(FETCH_TIMEOUT_MS)]
        : [input.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)],
    ),
  });
  if (!response.ok) {
    throw new Error(`Could not read the eve registry (${response.status}).`);
  }
  const entries = parseRegistryIndex(await response.json());
  cache = { entries, fetchedAtMs: input.nowMs, url: input.url };
  return entries;
}

/**
 * Annotates each row with whether the authored tree already holds its file.
 *
 * Development mounts the authored `agent/` directory at `/source`, so
 * `agent/channels/slack.ts` is `/source/channels/slack.ts`. eve derives every
 * integration name from its path, so a present file is an exact answer rather
 * than a heuristic. The field is left absent — never `false` — when the source
 * cannot be read, so "unknown" is not reported as "not installed".
 */
async function annotateInstalled(input: {
  readonly ctx: Pick<ToolContext, "getSandbox">;
  readonly entries: readonly CatalogEntry[];
  readonly rows: readonly FoundIntegration[];
}): Promise<readonly FoundIntegration[]> {
  const targets = new Map(
    input.entries.flatMap((entry) =>
      entry.authoredTarget === undefined ? [] : [[entry.address, entry.authoredTarget] as const],
    ),
  );
  if (input.rows.every((row) => targets.get(row.address) === undefined)) return input.rows;

  let sandbox: Awaited<ReturnType<ToolContext["getSandbox"]>>;
  try {
    sandbox = await input.ctx.getSandbox();
  } catch {
    return input.rows;
  }

  return await Promise.all(
    input.rows.map(async (row) => {
      const target = targets.get(row.address);
      if (target === undefined) return row;
      const path = `${AUTHORED_SOURCE_MOUNT}/${target.slice(AUTHORED_PREFIX.length)}`;
      try {
        const content = await sandbox.readTextFile({ path });
        return { ...row, installed: content !== null };
      } catch {
        return row;
      }
    }),
  );
}

export default defineTool({
  description:
    "Search the eve registry for integrations this project can add: channels, MCP connections, extensions, and observability. Read-only — it installs nothing. Call it before writing an integration by hand, and report the item address (for example `channel/slack`) so the developer can install it with `/add`.",
  inputSchema,
  outputSchema,
  async execute(input, ctx) {
    const errors: { message: string; registry: string }[] = [];
    let url: string;
    try {
      url = resolveRegistryIndexUrl();
    } catch (error) {
      return {
        errors: [{ message: errorMessage(error), registry: "eve" }],
        hasMore: false,
        items: [],
        total: 0,
      };
    }

    let entries: readonly CatalogEntry[] = [];
    try {
      entries = await loadRegistryIndex({ nowMs: Date.now(), signal: ctx.abortSignal, url });
    } catch (error) {
      errors.push({ message: errorMessage(error), registry: url });
    }

    const selection: {
      category?: Category;
      entries: readonly CatalogEntry[];
      limit?: number;
      offset?: number;
      query?: string;
    } = { entries };
    const category = typeof input.category === "string" ? input.category : undefined;
    if (category !== undefined && isCategory(category)) selection.category = category;
    if (typeof input.limit === "number") selection.limit = input.limit;
    if (typeof input.offset === "number") selection.offset = input.offset;
    if (typeof input.query === "string") selection.query = input.query;
    const page = selectIntegrationPage(selection);

    const result: {
      errors: { message: string; registry: string }[];
      hasMore: boolean;
      items: readonly FoundIntegration[];
      nextOffset?: number;
      total: number;
    } = {
      errors,
      hasMore: page.hasMore,
      items: await annotateInstalled({ ctx, entries, rows: page.items }),
      total: page.total,
    };
    if (page.nextOffset !== undefined) result.nextOffset = page.nextOffset;
    return result;
  },
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
