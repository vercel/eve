import { access } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { mockSkill } from "#internal/testing/mocks/mock-skill.js";

describe("mockSkill", () => {
  it("materializes skill package files and cleans them after the test", async ({
    onTestFinished,
  }) => {
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

    onTestFinished(async () => {
      await expect(access(source.rootPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
    const referencesPath = source.referencesPath;
    expect(referencesPath).toBeDefined();

    if (referencesPath === undefined) {
      throw new Error("Expected mock skill to materialize references.");
    }

    await expect(access(source.rootPath)).resolves.toBeUndefined();
    await expect(access(source.skillFilePath)).resolves.toBeUndefined();
    await expect(access(referencesPath)).resolves.toBeUndefined();
  });

  it("allows explicit cleanup to run more than once", async () => {
    const skill = await mockSkill({ name: "weather", description: "Weather guidance." });
    if (skill.source.sourceKind !== "skill-package") {
      throw new Error("Expected mock skill source to be a skill package.");
    }
    await expect(access(skill.source.rootPath)).resolves.toBeUndefined();
    await skill.cleanup();
    await skill.cleanup();
    await expect(access(skill.source.rootPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
