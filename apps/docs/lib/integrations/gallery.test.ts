import { describe, expect, it } from "vitest";
import { integrations } from "./data";
import { compareByName, filterIntegrations, type GalleryFilter } from "./gallery";

const names = (filter: GalleryFilter, query = "") =>
  filterIntegrations(integrations, filter, query).map(({ name }) => name);

const alphabetical = (list: string[]) =>
  [...list].sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }));

describe("integrations gallery order", () => {
  it.each<GalleryFilter>(["channel", "connection", "extension", "memory", "instrumentation"])(
    "lists the %s tab alphabetically",
    (filter) => {
      const list = names(filter);
      expect(list.length).toBeGreaterThan(0);
      expect(list).toEqual(alphabetical(list));
    },
  );

  it("sorts keyword matches from other types into the Memory tab", () => {
    const memory = filterIntegrations(integrations, "memory", "");
    expect(memory.some(({ type }) => type !== "memory")).toBe(true);
    expect(memory).toEqual([...memory].sort(compareByName));
  });

  it("keeps search results alphabetical within a tab", () => {
    const list = names("connection", "mcp");
    expect(list).toEqual(alphabetical(list));
  });

  it("keeps All grouped by type with each group alphabetical", () => {
    const all = filterIntegrations(integrations, "all", "");
    const types = [...new Set(all.map(({ type }) => type))];
    expect(types).toEqual(["channel", "extension", "memory", "connection", "instrumentation"]);
    for (const type of types) {
      const group = all.filter((entry) => entry.type === type).map(({ name }) => name);
      expect(group, type).toEqual(alphabetical(group));
    }
  });
});
