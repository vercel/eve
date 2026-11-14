/**
 * Campaign-tag vocabulary and URL building for tracked links.
 *
 * @remarks
 * The point of routing this through a tool is consistency, not string concatenation. Analytics
 * treats `LinkedIn` and `linkedin`, or `Q3 Launch` and `q3-launch`, as different sources, so a
 * campaign tagged by hand across a week of posts arrives as several campaigns that have to be
 * reconciled later. Everything here exists to make that impossible: the source comes from a fixed
 * surface vocabulary, the medium is derived from it, and every free-text value is normalized the
 * same way.
 *
 * `utm_term` is deliberately absent. It carries the keyword on a paid search click, and nothing on
 * this team buys ads.
 *
 * @packageDocumentation
 */

/**
 * Analytics medium for each content surface.
 *
 * @remarks
 * Keyed by the same surface names the style skills use, so one vocabulary covers
 * `lint_against_style` and this. A surface missing from the map falls back to `referral`, which is
 * what analytics calls a link arriving from somewhere else on the web.
 */
const MEDIUM_BY_SURFACE: Readonly<Record<string, string>> = {
  bluesky: "social",
  email: "email",
  linkedin: "social",
  mastodon: "social",
  threads: "social",
  x: "social",
};

/** Fallback medium for a surface with no explicit mapping. */
const DEFAULT_MEDIUM = "referral";

/** Characters replaced when normalizing a tag value. */
const TAG_DISALLOWED = /[^a-z0-9]+/g;
const TAG_TRIM = /^-+|-+$/g;

/**
 * Maximum number of links accepted in one call.
 *
 * @remarks
 * A newsletter is the case that needs several at once. Past this, the caller is tagging a page
 * rather than a campaign.
 */
export const MAX_TRACKED_LINKS = 50;

/** Maximum length of a URL accepted, in characters. */
export const MAX_TRACKED_URL_LENGTH = 2000;

/** Maximum length of a campaign or content tag, in characters. */
export const MAX_TAG_LENGTH = 100;

/**
 * Resolve the analytics medium for a surface.
 *
 * @param surface - Content surface the link will appear on.
 * @returns The medium, or `referral` when the surface has no mapping.
 */
export const mediumForSurface = (surface: string): string =>
  MEDIUM_BY_SURFACE[surface] ?? DEFAULT_MEDIUM;

/**
 * Normalize a free-text tag into the form analytics can group on.
 *
 * @remarks
 * Lowercase and hyphenated, which is the convention that survives being typed by several people.
 * This is deliberately not the artifact-id slug: that one is capped and falls back to `untitled`
 * because it becomes part of a storage key, whereas an empty campaign tag should be reported as a
 * problem rather than silently renamed.
 *
 * @param value - Raw tag value.
 * @returns The normalized tag, or an empty string when nothing usable remains.
 */
export const normalizeTag = (value: string): string =>
  value.toLowerCase().replace(TAG_DISALLOWED, "-").replace(TAG_TRIM, "");

/**
 * Add campaign parameters to a URL.
 *
 * @remarks
 * Existing query parameters and the fragment are preserved, and an existing `utm_*` of the same
 * name is overwritten rather than duplicated, so re-tagging a link that was already tagged is safe.
 *
 * @param url - Absolute http(s) URL.
 * @param params - Parameter names and values to set.
 * @returns The tagged URL, or `null` when the input is not an absolute http(s) URL.
 */
export const addTrackingParams = (
  url: string,
  params: Readonly<Record<string, string>>
): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  for (const [name, value] of Object.entries(params)) {
    parsed.searchParams.set(name, value);
  }
  return parsed.toString();
};
