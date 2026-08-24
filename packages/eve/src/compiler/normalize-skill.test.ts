import { describe, expect, it, vi } from "vitest";

import { createModuleSourceRef } from "#discover/manifest.js";
import { compileSkillSource } from "#compiler/normalize-skill.js";

describe("compileSkillSource", () => {
  it("rejects unsupported dynamic skill event keys", async () => {
    const source = createModuleSourceRef({
      logicalPath: "skills/generated.ts",
      sourceId: "generated-skill",
    });

    await expect(
      compileSkillSource(source, {
        binding: {
          backing: {
            kind: "programmatic",
            moduleId: "skills/generated.ts",
            registryId: "test",
            revision: "test-v1",
          },
          logicalPath: source.logicalPath,
          owner: { kind: "application" },
        },
        moduleLoader: {
          load: vi.fn(async () => ({
            default: {
              events: { "step.started": async () => ({}) },
              kind: "eve:dynamic",
            },
          })),
        },
      }),
    ).rejects.toThrow('Unsupported event: "step.started"');
  });
});
