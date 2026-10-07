import { describe, expect, it, vi } from "vitest";
import { z } from "#compiled/zod/index.js";
import { normalizeScheduleCollectionDefinition } from "#internal/authored-definition/schedule-collection.js";
import { defineDynamicSchedules } from "#public/schedules/subscription.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";

const valid = {
  provider: inMemoryScheduleProvider(),
  inputSchema: z.object({ task: z.string() }),
  auth: () => null,
  run: async () => {},
};

describe("normalizeScheduleCollectionDefinition", () => {
  it.each([
    ["no auth", { auth: undefined }, '"auth" is required'],
    ["no input schema", { inputSchema: undefined }, '"inputSchema" is required'],
    ["a malformed schema", { inputSchema: { "~standard": {} } }, "validate function"],
    ["no run", { run: undefined }, '"run" is required'],
    [
      "a malformed preparation hook",
      { preparePayload: true },
      '"preparePayload" must be a function',
    ],
    [
      "approval for the removed update tool",
      { approval: { update: () => "user-approval" } },
      "update",
    ],
    ["unsupported deferral", { tool: "deferred" }, "deferred tools are not supported"],
    ["the removed capture hook", { resolvePayload: () => ({}) }, "resolvePayload"],
    ["the removed deliveries", { deliveries: {} }, "deliveries"],
  ])("rejects a subscription with %s", (_label, override, message) => {
    const definition = defineDynamicSchedules({ ...valid, ...override } as never);
    expect(() => normalizeScheduleCollectionDefinition(definition, "Invalid.")).toThrow(message);
  });

  it("rejects model approval configuration on code-only definitions at type and runtime boundaries", () => {
    const invalid = {
      ...valid,
      tool: false as const,
      approval: { create: () => "user-approval" as const },
    };
    // @ts-expect-error Code-only scheduling cannot configure model-call approval.
    const definition = defineDynamicSchedules(invalid);
    expect(() => normalizeScheduleCollectionDefinition(definition, "Invalid.")).toThrow(
      "cannot be configured",
    );
  });

  it("defaults to Vercel and preserves an explicit provider override", () => {
    vi.stubEnv("EVE_DEV", "");
    try {
      const { provider, ...options } = valid;
      const implicit = defineDynamicSchedules({ ...options });
      expect(normalizeScheduleCollectionDefinition(implicit, "Invalid.").provider.kind).toBe(
        "vercel",
      );
      expect(defineDynamicSchedules({ ...options, provider }).provider).toBe(provider);
      vi.stubEnv("EVE_DEV", "1");
      expect(defineDynamicSchedules({ ...options }).provider.kind).toBe("in-memory");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("accepts a schema and callback without configured deliveries", () => {
    expect(() =>
      normalizeScheduleCollectionDefinition(defineDynamicSchedules(valid), "Invalid."),
    ).not.toThrow();
  });
});
