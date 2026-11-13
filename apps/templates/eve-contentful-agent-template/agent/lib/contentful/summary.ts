/* Compact entry summaries for the searchable copy of Contentful content. */
import { entryStatus, guessTitle, readString } from "./content";
import { APP_HOST, PAGE_ROUTES, publicUrl, spacePath } from "./model";
import type { EntrySummary, RawEntry } from "./types";

/**
 * Projects a Contentful entry into a compact summary in the active locale.
 *
 * @param entry - CMA entry including identity, version metadata, and localized fields.
 * @param spaceId - Raw configured space ID containing the entry.
 * @returns Identity, title, publication state, timestamps, and available editor or website links.
 */
export const summarizeEntry = (
  entry: RawEntry,
  spaceId: string
): EntrySummary => {
  const page = Object.entries(PAGE_ROUTES).find(
    ([, route]) =>
      route.spaceId === spaceId &&
      route.contentTypeId === entry.sys.contentType?.sys.id
  )?.[0];
  const slug = readString(entry.fields, "slug");
  return {
    contentfulUrl: `${APP_HOST}${spacePath(spaceId)}/entries/${entry.sys.id}`,
    date: readString(entry.fields, "date"),
    entryId: entry.sys.id,
    page: entry.sys.contentType?.sys.id ?? "unknown",
    publishedAt: entry.sys.publishedAt ?? null,
    slug,
    status: entryStatus(entry.sys),
    title: guessTitle(entry.fields),
    updatedAt: entry.sys.updatedAt ?? null,
    url: page && slug ? publicUrl(page, slug) : null,
  };
};
