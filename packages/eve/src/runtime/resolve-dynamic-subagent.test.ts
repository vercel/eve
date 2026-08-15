import { describe, expect, it } from "vitest";

import { normalizeResolvedDynamicSubagentDefinition } from "#runtime/resolve-dynamic-subagent.js";

describe("normalizeResolvedDynamicSubagentDefinition", () => {
  it("accepts and omits compile-time build configuration", () => {
    const handler = () => null;
    const resolved = normalizeResolvedDynamicSubagentDefinition(
      {
        eventNames: ["session.started"],
        logicalPath: "agent.ts",
        sourceId: "agent.ts",
        sourceKind: "module",
      },
      {
        build: { externalDependencies: ["eve-selfmod"] },
        events: { "session.started": handler },
        kind: "eve:dynamic",
      },
    );

    expect(resolved.events["session.started"]).toBe(handler);
    expect(resolved).not.toHaveProperty("build");
  });
});
