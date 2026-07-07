import { describe, expect, it } from "vitest";

import type { CompiledSkillDefinition } from "#compiler/manifest.js";
import { formatAvailableSkillsSection } from "#execution/skills/instructions.js";

function createTestSkill(
  overrides: Partial<CompiledSkillDefinition> = {},
): CompiledSkillDefinition {
  const name = overrides.name ?? "test-skill";

  return {
    description: "A test skill",
    logicalPath: `skills/${name}/SKILL.md`,
    markdown: "# Test\nDo the thing.",
    name,
    sourceId: "test-skill-source",
    sourceKind: "markdown",
    ...overrides,
  } as CompiledSkillDefinition;
}

describe("formatAvailableSkillsSection", () => {
  it("returns null when there are no skills", () => {
    const result = formatAvailableSkillsSection([]);
    expect(result).toBeNull();
  });

  it("produces available skills menu listing all skills", () => {
    const skill = createTestSkill();
    const result = formatAvailableSkillsSection([skill]);

    expect(result).not.toBeNull();
    expect(result).toContain("Available skills");
    expect(result).toContain(
      "If the user names a skill or the request clearly matches one of the descriptions below, call load_skill before proceeding.",
    );
    expect(result).toContain(
      "If multiple skills match, activate the minimal set that covers the task.",
    );
    expect(result).toContain(
      "Skill files are available after load_skill resolves the active sandbox skill location.",
    );
    expect(result).toContain(
      "resolve them relative to the directory containing that specific SKILL.md",
    );
    expect(result).toContain("- test-skill: A test skill");
    expect(result).not.toContain("/workspace/skills");
  });

  it("formats skill line with the resolved skill root", () => {
    const skill = createTestSkill({
      logicalPath: "skills/my-skill/SKILL.md",
      name: "my-skill",
    });

    const result = formatAvailableSkillsSection([skill], {
      skillRoot: "/home/agent/.agents/skills",
    });

    expect(result).toContain("Skill files live under `/home/agent/.agents/skills/<skill>/`.");
    expect(result).toContain(
      "- my-skill: A test skill (path: /home/agent/.agents/skills/my-skill/SKILL.md)",
    );
    expect(result).not.toContain("fallback");
  });

  it("always lists all skills in the menu regardless of activation state", () => {
    const s1 = createTestSkill({ logicalPath: "skills/skill-one/SKILL.md", name: "skill-one" });
    const s2 = createTestSkill({ logicalPath: "skills/skill-two/SKILL.md", name: "skill-two" });

    const result = formatAvailableSkillsSection([s1, s2]);

    expect(result).toContain("Available skills");
    expect(result).toContain("- skill-one: A test skill");
    expect(result).toContain("- skill-two: A test skill");
  });

  it("never includes active skill markdown content", () => {
    const skill = createTestSkill({ markdown: "# Full Instructions\nStep 1: Do this." });

    const result = formatAvailableSkillsSection([skill]);

    expect(result).toContain("Available skills");
    expect(result).toContain("- test-skill: A test skill");
    expect(result).not.toContain("Skill (test-skill)");
    expect(result).not.toContain("# Full Instructions");
  });
});
