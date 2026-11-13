import { describe, expect, it } from "vitest";
import { z } from "#compiled/zod/index.js";
import { defineDynamicSchedules } from "#public/schedules/subscription.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import { namedScopeDefinition } from "#runtime/schedules/named-scope.js";

describe("namedScopeDefinition", () => {
  const definition = defineDynamicSchedules({
    provider: inMemoryScheduleProvider(),
    inputSchema: z.object({ task: z.string() }),
    scopes: { personal: () => "alice" },
    auth: () => null,
    run: async () => {},
  });

  it("builds a scope's definition once", () => {
    const personal = namedScopeDefinition(definition, "personal");
    expect(namedScopeDefinition(definition, "personal")).toBe(personal);
    expect(personal.scopes).toBeUndefined();
  });

  it.each(["team", "constructor", "toString", "hasOwnProperty", "__proto__"])(
    "resolves no scope the definition doesn't declare: %s",
    (name) => {
      expect(() => namedScopeDefinition(definition, name)).toThrow(
        `has no scope "${name}". Its scopes are: personal.`,
      );
    },
  );
});
