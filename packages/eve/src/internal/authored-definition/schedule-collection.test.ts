import { describe, expect, it } from "vitest";

import { normalizeScheduleCollectionDefinition } from "#internal/authored-definition/schedule-collection.js";
import { defineScheduleCollection } from "#public/schedules/collection.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";

const definition = () =>
  defineScheduleCollection({
    provider: inMemoryScheduleProvider(),
    scope: "principal_1",
    runAs: "creator",
  });

describe("normalizeScheduleCollectionDefinition", () => {
  it("accepts a branded minimal collection", () => {
    const value = definition();
    expect(normalizeScheduleCollectionDefinition(value, "invalid")).toBe(value);
  });

  it("rejects unbranded and incomplete definitions", () => {
    expect(() =>
      normalizeScheduleCollectionDefinition(
        { provider: inMemoryScheduleProvider(), scope: "principal_1" },
        "invalid",
      ),
    ).toThrow("invalid");
    const value = definition();
    Object.assign(value.provider, { invoke: undefined });
    expect(() => normalizeScheduleCollectionDefinition(value, "invalid")).toThrow(
      "provider.invoke must be a function",
    );
  });

  it.each([undefined, "parent", "user", null])(
    "requires an explicit supported execution identity (%s)",
    (runAs) => {
      const value = definition();
      Object.assign(value, { runAs });
      expect(() => normalizeScheduleCollectionDefinition(value, "invalid")).toThrow(
        '"runAs" must be "creator" or "app"',
      );
    },
  );

  it("rejects unknown keys and invalid tool flags", () => {
    const unknown = definition();
    Object.assign(unknown, { run: () => {} });
    expect(() => normalizeScheduleCollectionDefinition(unknown, "invalid")).toThrow("invalid");
    const invalid = definition();
    Object.assign(invalid, { tools: { create: true } });
    expect(() => normalizeScheduleCollectionDefinition(invalid, "invalid")).toThrow(
      '"tools" must be a boolean',
    );
  });
});
