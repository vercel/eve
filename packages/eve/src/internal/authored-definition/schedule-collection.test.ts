import { describe, expect, it } from "vitest";
import { z } from "zod";

import { normalizeScheduleCollectionDefinition } from "#internal/authored-definition/schedule-collection.js";
import { defineScheduleCollection } from "#public/schedules/collection.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";

const definition = () =>
  defineScheduleCollection({
    payloadSchema: z.object({ query: z.string() }),
    provider: inMemoryScheduleProvider(),
    scope: "principal_1",
    tools: true,
    run: async () => undefined,
  });

describe("normalizeScheduleCollectionDefinition", () => {
  it("accepts a branded collection", () => {
    const value = definition();
    expect(normalizeScheduleCollectionDefinition(value, "invalid")).toBe(value);
  });

  it("rejects unbranded and incomplete definitions", () => {
    expect(() =>
      normalizeScheduleCollectionDefinition(
        {
          payloadSchema: z.object({ query: z.string() }),
          provider: inMemoryScheduleProvider(),
          scope: "principal_1",
          tools: true,
          run: async () => undefined,
        },
        "invalid",
      ),
    ).toThrow("invalid");

    const value = definition();
    Object.assign(value.provider, { invoke: undefined });
    expect(() => normalizeScheduleCollectionDefinition(value, "invalid")).toThrow(
      "provider.invoke must be a function",
    );
  });

  it("accepts an input resolver and rejects non-functions", () => {
    const valid = defineScheduleCollection({
      ...definition(),
      resolvePayload: (input) => input,
    });
    expect(normalizeScheduleCollectionDefinition(valid, "invalid")).toBe(valid);

    Object.assign(valid, { resolvePayload: "not a function" });
    expect(() => normalizeScheduleCollectionDefinition(valid, "invalid")).toThrow(
      '"resolvePayload" must be a function',
    );
  });

  it("rejects unknown and invalid tool options", () => {
    const unknown = definition() as typeof definition extends () => infer T ? T : never;
    Object.assign(unknown, { extra: true });
    expect(() => normalizeScheduleCollectionDefinition(unknown, "invalid")).toThrow("invalid");

    const invalid = definition();
    Object.assign(invalid, { tools: { invoke: "yes" } });
    expect(() => normalizeScheduleCollectionDefinition(invalid, "invalid")).toThrow(
      "tools.invoke must be a boolean",
    );
  });
});
