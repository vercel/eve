import { channelEntries } from "@eve/catalog";
import { describe, expect, test } from "vitest";
import { SCAFFOLDABLE_CHANNELS } from "./channels-catalog.js";

describe("SCAFFOLDABLE_CHANNELS", () => {
  test("covers exactly the catalog's scaffoldable channels", () => {
    const catalogScaffoldable = channelEntries()
      .filter((entry) => entry.surfaces.scaffoldable)
      .map((entry) => entry.slug)
      .sort();
    const overlaySlugs = SCAFFOLDABLE_CHANNELS.map((channel) => channel.slug).sort();

    expect(channelEntries().some((entry) => !entry.surfaces.scaffoldable)).toBe(true);
    expect(overlaySlugs).toEqual(catalogScaffoldable);
  });

  test("associates scaffoldable channels with canonical registry items", () => {
    expect(
      SCAFFOLDABLE_CHANNELS.map(({ kind, registryItem, slug }) => ({ kind, registryItem, slug })),
    ).toEqual([
      { kind: "web", registryItem: "channel/web", slug: "eve" },
      { kind: "slack", registryItem: "channel/slack", slug: "slack" },
    ]);
  });
});
