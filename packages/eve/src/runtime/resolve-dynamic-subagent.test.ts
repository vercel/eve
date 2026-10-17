import { describe, expect, it } from "vitest";

import { normalizeResolvedDynamicSubagentDefinition } from "#runtime/resolve-dynamic-subagent.js";

describe("normalizeResolvedDynamicSubagentDefinition", () => {
  it("accepts and omits compile-time build configuration", () => {
    const handler = () => null;
    const resolved = normalizeResolvedDynamicSubagentDefinition(
      {
        eventNames: ["beforeSession"],
        logicalPath: "agent.ts",
        sourceId: "agent.ts",
        sourceKind: "module",
      },
      {
        events: { beforeSession: handler },
        kind: "eve:dynamic",
      },
    );

    expect(resolved.events["beforeSession"]).toBe(handler);
    expect(resolved).not.toHaveProperty("build");
  });
});
