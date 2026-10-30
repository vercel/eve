import type { Integration, IntegrationType } from "./data";

export type GalleryFilter = "all" | IntegrationType;

/**
 * Most-used integrations by slug, in display order. They lead their gallery
 * tab and type group; everything else follows alphabetically. Ranked by
 * observed usage as of October 2026; revisit as usage shifts.
 */
export const FEATURED_SLUGS: readonly string[] = [
  "slack",
  "github",
  "linear-agent",
  "linq",
  "photon",
  "linear",
  "notion",
];

const featuredRank = (integration: Integration): number => {
  const rank = FEATURED_SLUGS.indexOf(integration.slug);
  return rank === -1 ? FEATURED_SLUGS.length : rank;
};

/** Orders featured integrations first, then the rest alphabetically by name. */
export const compareForGallery = (left: Integration, right: Integration): number =>
  featuredRank(left) - featuredRank(right) ||
  left.name.localeCompare(right.name, "en", { sensitivity: "base" });

/**
 * Integrations shown for a gallery filter and search query. "All" keeps the
 * type grouping of `integrations`; every other tab uses `compareForGallery`,
 * including Memory, which matches by keyword across types.
 */
export const filterIntegrations = (
  integrations: Integration[],
  filter: GalleryFilter,
  query: string,
): Integration[] => {
  const normalized = query.trim().toLowerCase();
  const results = integrations.filter((integration) => {
    if (filter === "memory" && !integration.keywords?.includes("memory")) {
      return false;
    }
    if (filter !== "all" && filter !== "memory" && integration.type !== filter) {
      return false;
    }
    if (!normalized) {
      return true;
    }
    const haystack = [integration.name, integration.tagline, ...(integration.keywords ?? [])]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalized);
  });
  return filter === "all" ? results : results.sort(compareForGallery);
};
