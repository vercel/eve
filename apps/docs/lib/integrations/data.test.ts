import { describe, expect, it } from "vitest";
import { integrations } from "./data";

describe("integrations gallery order", () => {
  it("lists each integration type alphabetically by name", () => {
    const types = [...new Set(integrations.map(({ type }) => type))];
    for (const type of types) {
      const names = integrations.filter((entry) => entry.type === type).map(({ name }) => name);
      const sorted = [...names].sort((left, right) =>
        left.localeCompare(right, "en", { sensitivity: "base" }),
      );
      expect(names, type).toEqual(sorted);
    }
  });
});
