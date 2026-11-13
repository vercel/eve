import type { JsonValue } from "../json";
import { isString } from "../values";
import { callApi } from "./api";
import {
  environmentId as configuredEnvironmentId,
  publicOrigin,
} from "./config";
/**
 * Resolve Contentful and configured website URLs, fetch entries, and read version-pinned content pages.
 *
 * @packageDocumentation
 */
import {
  collectLinks,
  contentSections,
  entryStatus,
  flattenFields,
  guessTitle,
} from "./content";
import { contentLocale, projectEntryLocale } from "./locale";
import {
  APP_HOST,
  entryKey,
  PAGE_ROUTES,
  pageKindInSpace,
  spacePath,
} from "./model";
import type { PageKind } from "./model";
import type {
  Collection,
  Link,
  LinkedItem,
  LocalizedFields,
  NormalizedEntry,
  RawAsset,
  RawEntry,
} from "./types";

/**
 * How a URL addresses an entry.
 *
 * @remarks
 * `id` refs come from Contentful web-app links and identify the entry
 * directly. `slug` refs come from configured website links and need a lookup by the
 * page kind's configured space, content type, and slug field.
 */
type EntryRef =
  | { kind: "id"; spaceId: string; environmentId: string; entryId: string }
  | { kind: "slug"; page: PageKind; slug: string };

const origin = publicOrigin();
const PUBLIC_HOSTS = new Set(origin ? [new URL(origin).hostname] : []);

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

/**
 * Extracts one valid slug after an exact configured website path prefix.
 *
 * @param url - Candidate website URL, which must use the configured HTTPS host.
 * @param prefix - Configured path segments preceding the slug.
 * @returns The lowercase slug, or null for unsupported hosts, paths, or slug characters.
 */
const slugForPrefix = (url: URL, prefix: string): string | null => {
  if (
    url.protocol !== "https:" ||
    !PUBLIC_HOSTS.has(url.hostname.toLowerCase())
  ) {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const expected = prefix.split("/").filter(Boolean);
  if (segments.length !== expected.length + 1) {
    return null;
  }
  const prefixMatches = expected.every(
    (segment, index) => segments[index].toLowerCase() === segment
  );
  if (!prefixMatches) {
    return null;
  }
  const slug = segments.at(-1)?.toLowerCase();
  return slug !== undefined && SLUG_PATTERN.test(slug) ? slug : null;
};

/* Contentful web-app entry link; groups are space, optional environment, entry. */
const ENTRY_URL =
  /^https:\/\/app\.contentful\.com\/spaces\/(?<spaceId>[A-Za-z0-9_-]+)(?:\/environments\/(?<environmentId>[A-Za-z0-9_.-]+))?\/entries\/(?<entryId>[A-Za-z0-9_-]+)/u;

/**
 * Parse a Contentful web-app entry URL or a configured website page URL.
 *
 * @param input - The URL as it appeared in a message. Surrounding whitespace,
 * trailing slashes, query strings, and fragments are tolerated.
 * @returns An {@link EntryRef}, or null when the URL is not a supported URL format.
 *
 * @example
 * ```ts
 * // With an article route configured at https://www.example.com/articles:
 * parseEntryUrl("https://www.example.com/articles/getting-started");
 * // { kind: "slug", page: "article", slug: "getting-started" }
 *
 * parseEntryUrl("https://app.contentful.com/spaces/abc/entries/xyz");
 * // { kind: "id", spaceId: "abc", environmentId: "master", entryId: "xyz" }
 * ```
 */
export const parseEntryUrl = (input: string): EntryRef | null => {
  const url = input.trim();
  const parsed = URL.parse(url);
  if (parsed) {
    for (const [page, route] of Object.entries(PAGE_ROUTES)) {
      for (const { prefix } of route.urls) {
        const slug = slugForPrefix(parsed, prefix);
        if (slug === null) {
          continue;
        }
        return { kind: "slug", page, slug };
      }
    }
  }
  const match = ENTRY_URL.exec(url);
  if (!match) {
    return null;
  }
  const [, spaceId, environmentId, entryId] = match;
  return {
    entryId,
    environmentId: environmentId ?? configuredEnvironmentId(),
    kind: "id",
    spaceId,
  };
};

/* Result of a slug lookup: the best match plus any others sharing the slug. */
interface SlugMatch {
  /* Ids of the other matching entries, best match excluded. */
  duplicates: string[];
  entry: RawEntry;
}

/**
 * Finds a content-type-specific slug and reports ambiguity without silently hiding duplicates.
 *
 * @param base - Allowlisted CMA space/environment base path.
 * @param contentTypeId - Content type whose slug field should be queried.
 * @param slug - Exact slug value to search for.
 * @param signal - Cancellation signal for the lookup.
 * @returns The preferred match and remaining matching IDs, or null when no entry matches.
 * @remarks Published matches rank before drafts; newer updates break ties.
 */
const findEntryBySlug = async (
  base: string,
  contentTypeId: string,
  slug: string,
  signal?: AbortSignal
): Promise<SlugMatch | null> => {
  const { items } = await callApi<Collection<RawEntry>>(
    `${base}/entries`,
    { content_type: contentTypeId, "fields.slug": slug, limit: "10" },
    signal
  );
  if (items.length === 0) {
    return null;
  }
  const ranked = [...items].toSorted((a, b) => {
    const aLive = a.sys.publishedVersion === undefined ? 0 : 1;
    const bLive = b.sys.publishedVersion === undefined ? 0 : 1;
    if (aLive !== bLive) {
      return bLive - aLive;
    }
    return (b.sys.updatedAt ?? "").localeCompare(a.sys.updatedAt ?? "");
  });
  return { duplicates: ranked.slice(1).map((e) => e.sys.id), entry: ranked[0] };
};

/**
 * Load the entry addressed by an ID reference or a public-page slug.
 *
 * @param ref - Reference parsed by {@link parseEntryUrl}; direct IDs retain their environment.
 * @param signal - Optional cancellation passed to the lookup.
 * @returns The raw entry, space/environment, and other matching IDs for an ambiguous slug.
 * @throws {@link Error} If no slug matches, the CMA lookup fails, or cancellation occurs.
 * @remarks Slug lookups use the configured environment and prefer a published version, then the newest update.
 */
const resolveEntry = async (
  ref: EntryRef,
  signal?: AbortSignal
): Promise<ResolvedEntry> => {
  if (ref.kind === "id") {
    const { spaceId, environmentId, entryId } = ref;
    const entry = await callApi<RawEntry>(
      `${spacePath(spaceId, environmentId)}/entries/${entryId}`,
      {},
      signal
    );
    return { duplicates: [], entry, environmentId, spaceId };
  }
  const { spaceId, contentTypeId } = PAGE_ROUTES[ref.page];
  const environmentId = configuredEnvironmentId();
  const match = await findEntryBySlug(
    spacePath(spaceId, environmentId),
    contentTypeId,
    ref.slug,
    signal
  );
  if (!match) {
    throw new Error(
      `No ${ref.page} entry with slug "${ref.slug}" was found in Contentful. ` +
        "Check the URL, or whether the page has been created in Contentful yet."
    );
  }
  return { ...match, environmentId, spaceId };
};

/* Absolute URL for an asset file; Contentful returns protocol-relative URLs. */
const assetUrl = (file: { url?: string } | undefined): string | undefined => {
  if (!file?.url) {
    return undefined;
  }
  return file.url.startsWith("//") ? `https:${file.url}` : file.url;
};

/**
 * Loads entry and asset references needed to flatten the parent entry's fields.
 *
 * @param base - Allowlisted CMA space/environment base path for referenced resources.
 * @param rawFields - Parent entry fields whose nested link objects should be collected.
 * @param signal - Cancellation signal for linked-resource reads.
 * @returns Available linked-resource summaries keyed by referenced ID.
 */
const resolveLinked = async (
  base: string,
  rawFields: LocalizedFields,
  signal?: AbortSignal
): Promise<LinkedItem[]> => {
  const links = new Map<string, Link>();
  for (const perLocale of Object.values(rawFields)) {
    collectLinks(perLocale[contentLocale()], links);
  }
  const idsOf = (linkType: string) =>
    [...links.values()]
      .filter((l) => l.sys.linkType === linkType)
      .map((l) => l.sys.id)
      .slice(0, 100);
  const fetchByIds = async <T>(path: string, ids: string[]): Promise<T[]> => {
    if (ids.length === 0) {
      return [];
    }
    try {
      const response = await callApi<Collection<T>>(
        `${base}/${path}`,
        { limit: "100", "sys.id[in]": ids.join(",") },
        signal
      );
      return response.items;
    } catch {
      return [];
    }
  };

  const [entries, assets] = await Promise.all([
    fetchByIds<RawEntry>("entries", idsOf("Entry")),
    fetchByIds<RawAsset>("assets", idsOf("Asset")),
  ]);
  const projectedEntries = await Promise.all(
    entries.map(async (raw): Promise<LinkedItem[]> => {
      try {
        const item = await projectEntryLocale(base, raw, signal);
        return [
          {
            contentType: item.sys.contentType?.sys.id,
            id: item.sys.id,
            title: guessTitle(item.fields),
            type: "Entry",
          },
        ];
      } catch {
        return [];
      }
    })
  );
  return [
    ...projectedEntries.flat(),
    ...assets.map((item): LinkedItem => ({
      id: item.sys.id,
      title: item.fields?.title?.[contentLocale()] ?? null,
      type: "Asset",
      url: assetUrl(item.fields?.file?.[contentLocale()]),
    })),
  ];
};

/**
 * Fetch a Contentful entry by URL and flatten it into a model-friendly representation.
 *
 * @remarks
 * Makes one request to load the entry (or one slug query for configured website
 * URLs), then in parallel resolves every linked entry and asset, at most 100
 * of each, to a title. Those secondary requests are best-effort: a failure
 * leaves the affected `linked` items out rather than failing the call.
 *
 * @param url - A URL in one of the shapes accepted by {@link parseEntryUrl}.
 * @param signal - Cancellation forwarded to all requests; secondary lookup failures remain best-effort.
 * @returns The {@link NormalizedEntry} for that URL.
 * @throws {@link Error} Error when the URL is not a supported URL format, when no entry matches a
 * configured website slug, or when the entry request itself fails.
 *
 * @example
 * ```ts
 * const entry = await getEntry("https://www.example.com/articles/my-post", ctx.abortSignal);
 * entry.status;        // "published"
 * entry.fields.title;  // "My post"
 * entry.contentfulUrl; // link to open the entry in Contentful
 * ```
 */
export const getEntry = async (
  url: string,
  signal?: AbortSignal
): Promise<NormalizedEntry> => {
  const ref = parseEntryUrl(url);
  if (!ref) {
    throw new Error(
      "Unsupported URL. Expected a Contentful entry link (https://app.contentful.com/spaces/<space>/[environments/<env>/]entries/<entry>) " +
        "or a public URL configured in CONTENTFUL_PAGE_ROUTES."
    );
  }

  const { spaceId, environmentId, entry, duplicates } = await resolveEntry(
    ref,
    signal
  );
  const base = spacePath(spaceId, environmentId);
  const contentTypeId = entry.sys.contentType?.sys.id ?? "unknown";
  const page =
    ref.kind === "slug" ? ref.page : pageKindInSpace(spaceId, contentTypeId);
  const projected = await projectEntryLocale(base, entry, signal);
  const rawFields = projected.fields ?? {};

  const linked = await resolveLinked(base, rawFields, signal);
  const { fields, truncated } = flattenFields(rawFields, linked);

  return {
    contentTypeId,
    contentfulUrl: `${APP_HOST}${spacePath(spaceId, environmentId)}/entries/${entry.sys.id}`,
    createdAt: entry.sys.createdAt ?? null,
    duplicates,
    entryId: entry.sys.id,
    environmentId,
    fields,
    linked,
    page,
    publishedAt: entry.sys.publishedAt ?? null,
    slug: isString(fields.slug) ? fields.slug : null,
    spaceId,
    status: entryStatus(entry.sys),
    truncated,
    updatedAt: entry.sys.updatedAt ?? null,
    url,
    version: entry.sys.version ?? null,
  };
};

/* The entry a ref points at, with where it lives. */
interface ResolvedEntry {
  /* Other entries sharing the slug; always empty for id refs. */
  duplicates: string[];
  entry: RawEntry;
  environmentId: string;
  spaceId: string;
}

/* One version-pinned content page; linked references are identities, not fetched bodies. */
interface ContentReadResult {
  contentfulUrl: string;
  entryId: string;
  environmentId: string;
  linked: { contentfulUrl: string; id: string; type: string }[];
  nextCursor: string | null;
  sections: ContentReadSection[];
  spaceId: string;
  status: NormalizedEntry["status"];
  updatedAt: string | null;
  version: number;
}

/* Text of one field, or of one top-level RichText block when block is present. */
interface ContentReadSection {
  block?: {
    hash: string;
    index: number;
    /* Raw block JSON, returned only when richTextJson is requested. */
    json?: JsonValue;
    nodeType: string;
  };
  end: number;
  field: string;
  start: number;
  text: string;
}

interface ContentCursor {
  entryKey: string;
  /* Older cursors lack a mode and predate block sections, so they restart. */
  mode: "json" | "text";
  offset: number;
  section: number;
  version: number;
}

const parseContentCursor = (cursor: string): ContentCursor => {
  try {
    // SAFETY: The decoded cursor is checked field-by-field below; malformed input is caught and never returned.
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf-8")
    ) as ContentCursor;
    if (
      !isString(parsed.entryKey) ||
      !(parsed.mode === "json" || parsed.mode === "text") ||
      !Number.isSafeInteger(parsed.version) ||
      parsed.version < 0 ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0 ||
      !Number.isSafeInteger(parsed.section) ||
      parsed.section < 0
    ) {
      throw new Error("Invalid cursor");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      "Invalid content cursor. Start a fresh read with cursor null.",
      { cause: error }
    );
  }
};

/* Expose a block's identity, and its raw JSON only when requested. */
const readBlock = (
  block: NonNullable<ReturnType<typeof contentSections>[number]["block"]>,
  json: boolean
): NonNullable<ContentReadSection["block"]> => ({
  hash: block.hash,
  index: block.index,
  ...(json && { json: block.node }),
  nodeType: block.nodeType,
});

/**
 * Slices a bounded content page while preserving complete rich-text blocks in JSON mode.
 *
 * @param allSections - Ordered text sections produced from the current entry version.
 * @param startSection - Section index encoded in the current read cursor.
 * @param startOffset - Character offset within the initial text section.
 * @param mode - Plain-text paging or whole-block JSON paging.
 * @returns Read sections and the next section/offset position.
 * @remarks The budget is 12,000 characters; an oversized first JSON block is returned whole to ensure progress.
 */
const pageSections = (
  allSections: ReturnType<typeof contentSections>,
  startSection: number,
  startOffset: number,
  mode: ContentCursor["mode"]
) => {
  let sectionIndex = startSection;
  let offset = startOffset;
  let budget = 12_000;
  const sections: ContentReadSection[] = [];
  while (sectionIndex < allSections.length && budget > 0) {
    const section = allSections[sectionIndex];
    if (mode === "json" && section.block) {
      const cost =
        section.text.length + JSON.stringify(section.block.node).length;
      if (cost > budget && sections.length > 0) {
        break;
      }
      sections.push({
        block: readBlock(section.block, true),
        end: section.text.length,
        field: section.field,
        start: 0,
        text: section.text,
      });
      budget -= cost;
      sectionIndex += 1;
      offset = 0;
      continue;
    }
    const text = section.text.slice(offset, offset + budget);
    sections.push({
      ...(section.block && { block: readBlock(section.block, false) }),
      end: offset + text.length,
      field: section.field,
      start: offset,
      text,
    });
    offset += text.length;
    budget -= text.length;
    if (offset >= section.text.length) {
      sectionIndex += 1;
      offset = 0;
    }
  }
  return { offset, sectionIndex, sections };
};

const requireCurrentCursor = (
  continuation: ContentCursor | null,
  key: string,
  version: number
) => {
  if (
    continuation &&
    (continuation.entryKey !== key || continuation.version !== version)
  ) {
    throw new Error(
      "The entry or its version changed. Discard earlier pages and start a fresh read with cursor null."
    );
  }
};

/**
 * Read text in pages pinned to an entry identity and version.
 *
 * @param url - Supported Contentful or configured website entry URL.
 * @param cursor - Null starts a read; a returned cursor continues the exact entry/version.
 * @param signal - Optional cancellation passed to entry resolution.
 * @param options - richTextJson adds each top-level RichText block's raw JSON. Those
 * blocks are never split, and a page always includes at least one section.
 * @returns Up to 12,000 characters with field paths, RichText block indexes and hashes,
 * linked identities, and a continuation cursor.
 * @throws {@link Error} If the URL/cursor is invalid, the entry/version changed or is unavailable, or the read fails.
 * @remarks Discard prior pages and restart after a version mismatch. Each top-level
 * RichText block is its own section, with offsets inside that block's text. Linked
 * identities are not fetched bodies, and each continuation rereads the current entry
 * to check its version.
 */
export const readEntryContent = async (
  url: string,
  cursor: string | null,
  signal?: AbortSignal,
  options: { richTextJson?: boolean } = {}
): Promise<ContentReadResult> => {
  const started = Date.now();
  const mode = options.richTextJson ? "json" : "text";
  const ref = parseEntryUrl(url);
  if (!ref) {
    throw new Error(
      "Unsupported URL. Use a Contentful entry or configured public page URL."
    );
  }
  const continuation = cursor === null ? null : parseContentCursor(cursor);
  if (continuation && continuation.mode !== mode) {
    throw new Error(
      "The cursor belongs to a read with a different richTextJson setting. Start a fresh read with cursor null."
    );
  }
  const { entry, spaceId, environmentId } = await resolveEntry(ref, signal);
  const key = entryKey(spaceId, environmentId, entry.sys.id);
  const { version } = entry.sys;
  if (version === undefined) {
    throw new Error(
      "Contentful did not return an entry version. A consistent paginated read is unavailable."
    );
  }
  requireCurrentCursor(continuation, key, version);
  const projected = await projectEntryLocale(
    spacePath(spaceId, environmentId),
    entry,
    signal
  );
  const allSections = contentSections(projected.fields ?? {}, {
    richTextBlocks: true,
  });
  const sectionIndex = continuation?.section ?? 0;
  const offset = continuation?.offset ?? 0;
  if (
    continuation &&
    (sectionIndex >= allSections.length ||
      offset >= allSections[sectionIndex].text.length)
  ) {
    throw new Error(
      "Content cursor is out of range. Start a fresh read with cursor null."
    );
  }
  const { sections, ...next } = pageSections(
    allSections,
    sectionIndex,
    offset,
    mode
  );
  const nextCursor =
    next.sectionIndex < allSections.length
      ? Buffer.from(
          JSON.stringify({
            entryKey: key,
            mode,
            offset: next.offset,
            section: next.sectionIndex,
            version,
          } satisfies ContentCursor)
        ).toString("base64url")
      : null;
  const links = new Map<string, Link>();
  for (const locales of Object.values(projected.fields ?? {})) {
    collectLinks(locales[contentLocale()], links);
  }
  console.info("contentful.content_read", {
    elapsedMs: Date.now() - started,
    hasMore: nextCursor !== null,
    sectionCount: sections.length,
  });
  return {
    contentfulUrl: `${APP_HOST}${spacePath(spaceId, environmentId)}/entries/${entry.sys.id}`,
    entryId: entry.sys.id,
    environmentId,
    linked: [...links.values()].map(({ sys }) => ({
      contentfulUrl: `${APP_HOST}${spacePath(spaceId, environmentId)}/${sys.linkType === "Asset" ? "assets" : "entries"}/${sys.id}`,
      id: sys.id,
      type: sys.linkType,
    })),
    nextCursor,
    sections,
    spaceId,
    status: entryStatus(entry.sys),
    updatedAt: entry.sys.updatedAt ?? null,
    version,
  };
};
