import type { JsonObject, JsonValue } from "../json";
import { ContentfulApiError, callApi } from "./api";
import { environmentId } from "./config";
/**
 * Bounded native CMA queries, field/reference projections, and optional actor resolution.
 *
 * @packageDocumentation
 */
import { entryStatus, queryFieldReferences } from "./content";
import type { QueryReference } from "./content";
import { contentfulQueryInputSchema } from "./input-schemas";
import type { ContentfulQueryInput } from "./input-schemas";
import { contentLocale, projectEntryLocale } from "./locale";
import type { ContentfulSpaceId } from "./model";
import { APP_HOST, CONTENTFUL_ID, QUERY_SPACES, spacePath } from "./model";
import type { QueryPagination } from "./schema";
import { queryPagination } from "./schema";
import type { Collection, EntryStatus, RawQueryEntry, RawSys } from "./types";

/* Selected entry data; reference results remain paired with their coverage metadata. */
type ContentfulQueryEntry = ReturnType<typeof queryEntryActors> &
  ReturnType<typeof queryEntryFields> & {
    contentfulUrl: string;
    contentTypeId: string | null;
    createdAt: string | null;
    entryId: string;
    firstPublishedAt: string | null;
    publishedAt: string | null;
    status: EntryStatus;
    updatedAt: string | null;
    version: number | null;
  } & (
    | ReturnType<typeof queryEntryReferences>
    | { referenceCoverage: null; references: null }
  );

/* One bounded query page. Null user/reference metadata means that projection was not requested. */
type ContentfulQueryResult = QueryPagination & {
  effectiveParameters: Record<string, string>;
  entries: ContentfulQueryEntry[];
  environmentId: string;
  referencesComplete: boolean | null;
  resultMode: "fields" | "references";
  spaceId: ContentfulSpaceId;
  truncated: boolean;
} & (
    | Awaited<ReturnType<typeof queryEntryUsers>>
    | { unresolvedUserIds: null; users: null }
  );

const QUERY_PARAMETER_NAME =
  /^(?:fields|sys|metadata)(?:\.[A-Za-z_][A-Za-z0-9_-]*)+(?:\[[A-Za-z]+\])?$/u;

const QUERY_SELECTOR =
  /^(?:sys|fields|metadata)(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/u;

const QUERY_PARAMETER_NAMES = new Set([
  "content_type",
  "query",
  "order",
  "select",
  "links_to_entry",
  "links_to_asset",
]);

const MAX_QUERY_FIELD_CHARS = 20_000;

const customQueryParameters = (input: ContentfulQueryInput) => {
  const parameters = new Map<string, string>();
  for (const { name, value } of input.parameters) {
    if (!(QUERY_PARAMETER_NAMES.has(name) || QUERY_PARAMETER_NAME.test(name))) {
      throw new Error(
        `Unsupported Contentful query parameter "${name}". Use limit/skip inputs for pagination; only entry query parameters are accepted.`
      );
    }
    if (parameters.has(name)) {
      throw new Error(`Duplicate Contentful query parameter "${name}".`);
    }
    parameters.set(name, value);
  }
  if (!input.includeArchived) {
    const archivedFilter = parameters.get("sys.archivedAt[exists]");
    if (archivedFilter !== undefined && archivedFilter !== "false") {
      throw new Error("Set includeArchived to true to query archived entries.");
    }
    parameters.set("sys.archivedAt[exists]", "false");
  }
  const selection = parameters.get("select") ?? "sys,fields._displayField";
  const selectors = selection.split(",").map((part) => part.trim());
  if (
    input.resultMode === "references" &&
    !(
      parameters.has("select") &&
      selectors.some(
        (selector) =>
          selector === "fields" ||
          (selector.startsWith("fields.") &&
            selector !== "fields._displayField")
      )
    )
  ) {
    throw new Error(
      "References mode requires an explicit select containing the component-bearing fields, e.g. sys,fields.title,fields.slug,fields.main."
    );
  }
  if (selectors.some((selector) => !QUERY_SELECTOR.test(selector))) {
    throw new Error(
      "Invalid Contentful select parameter. Select sys, fields, metadata, or their dot-separated properties."
    );
  }
  // Full sys is required to distinguish changed entries from published entries.
  parameters.set(
    "select",
    [
      ...new Set([
        "sys",
        ...selectors.filter(
          (selector) => selector !== "sys" && !selector.startsWith("sys.")
        ),
      ]),
    ].join(",")
  );
  if (!parameters.has("order")) {
    parameters.set("order", "sys.id");
  }
  parameters.set("limit", String(input.limit ?? 25));
  parameters.set("skip", String(input.skip ?? 0));
  const query = Object.fromEntries(parameters);
  if (new URLSearchParams(query).toString().length > 16_000) {
    throw new Error(
      "Contentful query exceeds the 16,000-character encoded parameter limit. Narrow the query."
    );
  }
  return query;
};

const MAX_QUERY_REFERENCES = 500;

const MAX_QUERY_REFERENCE_CHARS = 100_000;

interface ReferenceBudget {
  characters: number;
  count: number;
}

/* Extract structure from complete API fields; never serialize article prose. */
const queryEntryReferences = (
  entry: RawQueryEntry,
  budget: ReferenceBudget
) => {
  const references: QueryReference[] = [];
  const scannedFields: string[] = [];
  let found = 0;
  let unsupported = 0;
  for (const [key, locales] of Object.entries(entry.fields ?? {})) {
    const value = locales[contentLocale()];
    if (value === undefined) {
      continue;
    }
    const field = `/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    scannedFields.push(field);
    for (const reference of queryFieldReferences(value, field)) {
      if (reference === null) {
        unsupported += 1;
        continue;
      }
      found += 1;
      const cost =
        JSON.stringify(reference).length + (references.length ? 1 : 0);
      if (budget.count > 0 && cost <= budget.characters) {
        references.push(reference);
        budget.count -= 1;
        budget.characters -= cost;
      }
    }
  }
  return {
    referenceCoverage: {
      complete: found === references.length && unsupported === 0,
      found,
      omitted: found - references.length,
      returned: references.length,
      scannedFields,
      unsupported,
    },
    references,
  };
};

/* Keep JSON values intact; report oversized values separately from missing fields. */
const queryEntryFields = (
  entry: RawQueryEntry,
  budget: { remaining: number }
) => {
  const fields: [string, JsonValue][] = [];
  const truncatedFields: string[] = [];
  // Empty-object braces are reserved up front; count keys, punctuation and values.
  for (const [key, locales] of Object.entries(entry.fields ?? {})) {
    const value = locales[contentLocale()];
    if (value === undefined) {
      continue;
    }
    const cost =
      JSON.stringify(key).length +
      1 +
      JSON.stringify(value).length +
      (fields.length ? 1 : 0);
    if (cost > budget.remaining) {
      truncatedFields.push(`fields.${key}`);
      continue;
    }
    fields.push([key, value]);
    budget.remaining -= cost;
  }
  let metadata: JsonObject | null = null;
  if (entry.metadata !== undefined) {
    const cost = JSON.stringify(entry.metadata).length;
    if (cost > budget.remaining) {
      truncatedFields.push("metadata");
    } else {
      ({ metadata } = entry);
      budget.remaining -= cost;
    }
  }
  return { fields: Object.fromEntries(fields), metadata, truncatedFields };
};

const queryEntryActors = (sys: RawSys) => ({
  createdByUserId: sys.createdBy?.sys.id ?? null,
  publishedByUserId: sys.publishedBy?.sys.id ?? null,
  updatedByUserId: sys.updatedBy?.sys.id ?? null,
});

/**
 * Space user profile fields read from the CMA `/spaces/{spaceId}/users` endpoints.
 *
 * @remarks Only names and the ID are declared; callers must never copy emails or other profile fields.
 */
export interface RawSpaceUser {
  firstName?: string;
  lastName?: string;
  sys: { id: string };
}

const queryUserName = async (
  spaceId: string,
  userId: string,
  signal?: AbortSignal
): Promise<{ userId: string; name: string | null }> => {
  signal?.throwIfAborted();
  if (userId.length > 128 || !CONTENTFUL_ID.test(userId)) {
    throw new Error("Contentful returned an invalid actor user ID.");
  }
  try {
    // Users belong to the space, not to an environment.
    const user = await callApi<RawSpaceUser>(
      `/spaces/${spaceId}/users/${userId}`,
      {},
      signal
    );
    if (user.sys.id !== userId) {
      throw new Error("Contentful returned a mismatched user ID.");
    }
    const name = [user.firstName?.trim(), user.lastName?.trim()]
      .filter(Boolean)
      .join(" ");
    return { name: name.length === 0 ? null : name, userId };
  } catch (error) {
    if (error instanceof ContentfulApiError && error.status === 404) {
      return { name: null, userId };
    }
    throw error;
  }
};

const queryEntryUsers = async (
  spaceId: string,
  entries: RawQueryEntry[],
  signal?: AbortSignal
) => {
  // At most three actors per entry, with at most 50 entries per query page.
  const userIds = [
    ...new Set(
      entries.flatMap((entry) =>
        Object.values(queryEntryActors(entry.sys)).filter(
          (id): id is string => id !== null
        )
      )
    ),
  ];
  const users: { userId: string; name: string }[] = [];
  const unresolvedUserIds: string[] = [];
  for await (const offset of Array.from(
    { length: Math.ceil(userIds.length / 4) },
    (_, index) => index * 4
  )) {
    signal?.throwIfAborted();

    const batch = await Promise.all(
      userIds
        .slice(offset, offset + 4)
        .map((userId) => queryUserName(spaceId, userId, signal))
    );
    for (const user of batch) {
      if (user.name === null) {
        unresolvedUserIds.push(user.userId);
      } else {
        users.push({ name: user.name, userId: user.userId });
      }
    }
  }
  return { unresolvedUserIds, users };
};

/**
 * Execute one bounded, read-only CMA entries query in a configured space.
 *
 * @param input - Structured query input; null limit/skip mean 25/0, and null result mode means fields.
 * @param signal - Optional cancellation for the entry request and actor lookups.
 * @returns Selected values or references with pagination, truncation, and coverage metadata.
 * @throws {@link Error} If input/query parameters are invalid or an entry/actor request fails or is cancelled.
 * @remarks Reference completeness applies only to selected fields of returned entries.
 * User lookups are opt-in, deduplicated per page, and run at most four at a time. Missing
 * users or empty names appear in `unresolvedUserIds`; other lookup failures reject the call.
 * No persistent cache is used, and no linked entry bodies are fetched implicitly.
 */
export const runContentfulQuery = async (
  input: ContentfulQueryInput,
  signal?: AbortSignal
): Promise<ContentfulQueryResult> => {
  const parsed = contentfulQueryInputSchema.parse(input);
  const effectiveParameters = customQueryParameters(parsed);
  const spaceId = QUERY_SPACES[parsed.space];
  const collection = await callApi<Collection<RawQueryEntry>>(
    `${spacePath(spaceId)}/entries`,
    effectiveParameters,
    signal
  );
  // Reserve empty-object overhead for later entries before allocating field data.
  const budget = {
    remaining: MAX_QUERY_FIELD_CHARS - collection.items.length * 2,
  };
  const resultMode = parsed.resultMode ?? "fields";
  const referenceBudget = {
    characters: MAX_QUERY_REFERENCE_CHARS - collection.items.length * 2,
    count: MAX_QUERY_REFERENCES,
  };
  const userResolution = parsed.resolveUsers
    ? await queryEntryUsers(spaceId, collection.items, signal)
    : { unresolvedUserIds: null, users: null };
  const projected = await Promise.all(
    collection.items.map((entry) =>
      projectEntryLocale(spacePath(spaceId), entry, signal)
    )
  );
  const entries = projected.map((entry) => ({
    ...queryEntryActors(entry.sys),
    contentTypeId: entry.sys.contentType?.sys.id ?? null,
    contentfulUrl: `${APP_HOST}${spacePath(spaceId)}/entries/${entry.sys.id}`,
    createdAt: entry.sys.createdAt ?? null,
    entryId: entry.sys.id,
    firstPublishedAt: entry.sys.firstPublishedAt ?? null,
    publishedAt: entry.sys.publishedAt ?? null,
    status: entryStatus(entry.sys),
    updatedAt: entry.sys.updatedAt ?? null,
    version: entry.sys.version ?? null,
    ...queryEntryFields(
      resultMode === "references"
        ? {
            fields: Object.fromEntries(
              Object.entries(entry.fields ?? {}).filter(
                ([key]) => key === "title" || key === "slug"
              )
            ),
            sys: entry.sys,
          }
        : entry,
      budget
    ),
    ...(resultMode === "references"
      ? queryEntryReferences(entry, referenceBudget)
      : { referenceCoverage: null, references: null }),
  }));
  return {
    environmentId: environmentId(),
    spaceId,
    ...userResolution,
    ...queryPagination(collection, parsed.limit ?? 25, parsed.skip ?? 0),
    effectiveParameters,
    entries,
    // Reference completeness covers only returned, selected configured-locale fields.
    // Linked entries and unselected fields have not been inspected.
    referencesComplete:
      resultMode === "references"
        ? entries.every((entry) => entry.referenceCoverage?.complete)
        : null,
    resultMode,
    truncated: entries.some(
      (entry) =>
        entry.truncatedFields.length > 0 ||
        (entry.referenceCoverage?.omitted ?? 0) > 0
    ),
  };
};
