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

    expect(skill.input).toEqual({
      description: "Weather guidance.",
      markdown: "Weather guidance.",
      name: "weather",
    });
    expect(skill.input).not.toHaveProperty("sourceId");
    expect(skill.input).not.toHaveProperty("sourceKind");

    materializedRootPath = skill.paths.rootPath;
    const referencesPath = skill.paths.referencesPath;
    expect(referencesPath).toBeDefined();

    if (referencesPath === undefined) {
      throw new Error("Expected mock skill to materialize references.");
    }

    await expect(access(skill.paths.rootPath)).resolves.toBeUndefined();
    await expect(access(skill.paths.skillFilePath)).resolves.toBeUndefined();
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
