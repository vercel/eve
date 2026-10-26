import type { Integration, IntegrationType } from "./data";

export type GalleryFilter = "all" | IntegrationType;

/** Orders integrations alphabetically by name, case-insensitively. */
export const compareByName = (left: Integration, right: Integration): number =>
  left.name.localeCompare(right.name, "en", { sensitivity: "base" });

/**
 * Integrations shown for a gallery filter and search query. "All" keeps the
 * type grouping of `integrations`; every other tab is alphabetical, including
 * Memory, which matches by keyword across types.
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
  return filter === "all" ? results : results.sort(compareByName);
};
