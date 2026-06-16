import { channelEntries } from "@vercel/eve-catalog";
import { describe, expect, test } from "vitest";
import { SCAFFOLDABLE_CHANNELS } from "./channels-catalog.js";

describe("SCAFFOLDABLE_CHANNELS", () => {
  test("covers exactly the catalog's scaffoldable channels", () => {
    const catalogScaffoldable = channelEntries()
      .filter((entry) => entry.surfaces.scaffoldable)
      .map((entry) => entry.slug)
      .sort();
    const overlaySlugs = SCAFFOLDABLE_CHANNELS.map((channel) => channel.slug).sort();

    expect(overlaySlugs).toEqual(catalogScaffoldable);
  });

  test("excludes channels the catalog marks gallery-only", () => {
    const galleryOnly = channelEntries().filter((entry) => !entry.surfaces.scaffoldable);
    const overlaySlugs = new Set(SCAFFOLDABLE_CHANNELS.map((channel) => channel.slug));

    expect(galleryOnly.length).toBeGreaterThan(0);
    for (const entry of galleryOnly) {
      expect(overlaySlugs.has(entry.slug)).toBe(false);
    }
  });

  test("surfaces the catalog's `eve` web-chat channel as scaffolder kind `web`", () => {
    const eve = SCAFFOLDABLE_CHANNELS.find((channel) => channel.slug === "eve");
    expect(eve?.kind).toBe("web");
  });

  test("maps slack identity straight through", () => {
    const slack = SCAFFOLDABLE_CHANNELS.find((channel) => channel.slug === "slack");
    expect(slack?.kind).toBe("slack");
  });
});
