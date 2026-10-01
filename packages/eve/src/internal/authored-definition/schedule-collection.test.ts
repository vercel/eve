import { describe, expect, it } from "vitest";

import { normalizeScheduleCollectionDefinition } from "#internal/authored-definition/schedule-collection.js";
import { defineScheduleCollection } from "#public/schedules/collection.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";

const deliver = async () => {};
const valid = {
  provider: inMemoryScheduleProvider(),
  auth: () => null,
  deliveries: { "team-archive": { description: "Archive it.", deliver } },
};

describe("normalizeScheduleCollectionDefinition", () => {
  it.each([
    ["no auth", { auth: undefined }, '"auth" is required'],
    ["no deliveries", { deliveries: undefined }, '"deliveries" is required'],
    ["an empty deliveries record", { deliveries: {} }, "must define at least one delivery"],
    [
      "an invalid delivery name",
      { deliveries: { SMS: { description: "x", deliver } } },
      "must match",
    ],
    [
      "a delivery without deliver",
      { deliveries: { sms: { description: "x" } } },
      '"deliver" must be a function',
    ],
    [
      "an unknown delivery hook",
      { deliveries: { sms: { description: "x", deliver, format: () => "" } } },
      "format",
    ],
  ])("rejects a collection with %s", (_label, override, message) => {
    const definition = defineScheduleCollection({ ...valid, ...override } as never);
    expect(() => normalizeScheduleCollectionDefinition(definition, "Invalid.")).toThrow(message);
  });

  it("accepts a collection with auth and one delivery", () => {
    const definition = defineScheduleCollection(valid);
    expect(normalizeScheduleCollectionDefinition(definition, "Invalid.")).toBe(definition);
  });
});
