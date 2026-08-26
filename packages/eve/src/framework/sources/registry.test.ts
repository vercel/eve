import { describe, expect, it } from "vitest";

import { frameworkAgentSourceRegistry } from "#framework/sources/registry.js";

describe("frameworkAgentSourceRegistry", () => {
  it("provides task controls to every local node while keeping agent root-only", () => {
    const local = frameworkAgentSourceRegistry.registrations.find(
      (registration) => registration.applyTo === "all-local-nodes",
    );
    const root = frameworkAgentSourceRegistry.registrations.find(
      (registration) => registration.applyTo === "root",
    );

    expect(local?.source.modules.map((module) => module.logicalPath)).toEqual(
      expect.arrayContaining(["tools/task_cancel.ts", "tools/task_update.ts"]),
    );
    expect(root?.source.modules.map((module) => module.logicalPath)).toContain("tools/agent.ts");
    expect(root?.source.modules.map((module) => module.logicalPath)).not.toContain(
      "tools/task_cancel.ts",
    );
  });
});
