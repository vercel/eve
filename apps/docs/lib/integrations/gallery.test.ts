import { describe, expect, it } from "vitest";
import { type Integration, integrations } from "./data";
import {
  compareForGallery,
  FEATURED_SLUGS,
  filterIntegrations,
  type GalleryFilter,
} from "./gallery";

const alphabetical = (list: string[]) =>
  [...list].sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }));

/** Featured entries in `FEATURED_SLUGS` order, then the rest alphabetically. */
const expectGalleryOrder = (list: Integration[]) => {
  const featured = list.filter(({ slug }) => FEATURED_SLUGS.includes(slug));
  expect(list.slice(0, featured.length)).toEqual(featured);
  expect(featured.map(({ slug }) => slug)).toEqual(
    FEATURED_SLUGS.filter((slug) => featured.some((entry) => entry.slug === slug)),
  );
  const rest = list.slice(featured.length).map(({ name }) => name);
  expect(rest).toEqual(alphabetical(rest));
};

describe("integrations gallery order", () => {
  it("only features integrations listed in the gallery", () => {
    const slugs = new Set(integrations.map(({ slug }) => slug));
    for (const slug of FEATURED_SLUGS) {
      expect(slugs.has(slug), slug).toBe(true);
    }
  });

  it("leads the Channels tab with the first-party channels", () => {
    const slugs = filterIntegrations(integrations, "channel", "").map(({ slug }) => slug);
    expect(slugs.slice(0, 10)).toEqual([
      "eve",
      "slack",
      "github",
      "photon",
      "linq",
      "discord",
      "teams",
      "linear-agent",
      "telegram",
      "twilio",
    ]);
  });

  it.each<GalleryFilter>(["channel", "connection", "extension", "memory", "instrumentation"])(
    "lists the %s tab featured first, then alphabetically",
    (filter) => {
      const list = filterIntegrations(integrations, filter, "");
      expect(list.length).toBeGreaterThan(0);
      expectGalleryOrder(list);
    },
  );

  it("sorts keyword matches from other types into the Memory tab", () => {
    const memory = filterIntegrations(integrations, "memory", "");
    expect(memory.some(({ type }) => type !== "memory")).toBe(true);
    expect(memory).toEqual([...memory].sort(compareForGallery));
  });

  it("keeps the gallery order for search results within a tab", () => {
    expectGalleryOrder(filterIntegrations(integrations, "connection", "mcp"));
  });

  it("keeps All grouped by type with each group in gallery order", () => {
    const all = filterIntegrations(integrations, "all", "");
    const types = [...new Set(all.map(({ type }) => type))];
    expect(types).toEqual(["channel", "extension", "memory", "connection", "instrumentation"]);
    for (const type of types) {
      expectGalleryOrder(all.filter((entry) => entry.type === type));
    }
  });
});
