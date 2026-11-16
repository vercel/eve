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
      "approval for an unsupported operation",
      { approval: { rename: () => "user-approval" } },
      "rename",
    ],
    [
      "an invalid tool exposure",
      { tool: "hidden" },
      'Expected "tool" to be true, false, or "deferred".',
    ],
    ["the removed capture hook", { resolvePayload: () => ({}) }, "resolvePayload"],
    ["the removed deliveries", { deliveries: {} }, "deliveries"],
  ])("rejects a definition with %s", (_label, override, message) => {
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

  it("rejects a named scope's approval on code-only definitions at type and runtime boundaries", () => {
    const { scope: _scope, ...shared } = valid as typeof valid & { scope?: unknown };
    const invalid = {
      ...shared,
      tool: false as const,
      scopes: {
        personal: { resolve: () => "alice", approval: { create: () => "user-approval" as const } },
      },
    };
    // @ts-expect-error A code-only definition's scopes cannot configure model-call approval.
    const definition = defineDynamicSchedules(invalid);
    expect(() => normalizeScheduleCollectionDefinition(definition, "Invalid.")).toThrow(
      '"scopes.personal.approval" cannot be configured when tool is false',
    );
    // The same scope without approval is a valid code-only definition.
    const { approval: _approval, ...personal } = invalid.scopes.personal;
    expect(() =>
      normalizeScheduleCollectionDefinition(
        defineDynamicSchedules({ ...shared, tool: false, scopes: { personal } }),
        "Invalid.",
      ),
    ).not.toThrow();
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

  it.each(["", " ", "has space", "daily.report", "/requests", "requests/", "a//b", "é", 7])(
    "rejects the id %j",
    (id) => {
      const definition = defineDynamicSchedules({ ...valid, id } as never);
      expect(() => normalizeScheduleCollectionDefinition(definition, "Invalid.")).toThrow(
        'Invalid. "id" must be',
      );
    },
  );

  it("rejects an id longer than 64 characters", () => {
    const definition = defineDynamicSchedules({ ...valid, id: "a".repeat(65) });
    expect(() => normalizeScheduleCollectionDefinition(definition, "Invalid.")).toThrow('"id"');
  });

  it.each([
    "requests",
    "native-channel-workflows",
    "billing/requests",
    "crm__sync",
    "a".repeat(64),
  ])("accepts the id %j", (id) => {
    const definition = defineDynamicSchedules({ ...valid, id });
    expect(normalizeScheduleCollectionDefinition(definition, "Invalid.").id).toBe(id);
  });

  it("accepts a schema and callback without configured deliveries", () => {
    expect(() =>
      normalizeScheduleCollectionDefinition(defineDynamicSchedules(valid), "Invalid."),
    ).not.toThrow();
  });
});
