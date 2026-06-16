import { access } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { mockSkill } from "#internal/testing/mocks/mock-skill.js";

describe("mockSkill", () => {
  let materializedRootPath: string | undefined;

  it("materializes skill package files", async () => {
    const skill = await mockSkill({
      description: "Weather guidance.",
      name: "weather",
      references: {
        "forecast.md": "Use the latest forecast.",
      },
    });

    const source = skill.source;
    expect(source.sourceKind).toBe("skill-package");

    if (source.sourceKind !== "skill-package") {
      throw new Error("Expected mock skill source to be a skill package.");
    }

    materializedRootPath = source.rootPath;
    const referencesPath = source.referencesPath;
    expect(referencesPath).toBeDefined();

    if (referencesPath === undefined) {
      throw new Error("Expected mock skill to materialize references.");
    }

    await expect(access(source.rootPath)).resolves.toBeUndefined();
    await expect(access(source.skillFilePath)).resolves.toBeUndefined();
    await expect(access(referencesPath)).resolves.toBeUndefined();
  });

  it("cleans materialized tmpdirs after each test", async () => {
    expect(materializedRootPath).toBeDefined();

    if (materializedRootPath === undefined) {
      throw new Error("Expected previous test to create a mock skill root.");
    }

    await expect(access(materializedRootPath)).rejects.toThrow();
  });
});
