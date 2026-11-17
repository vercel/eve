import { describe, expect, it } from "vitest";

import type { CompiledSkillDefinition } from "#compiler/manifest.js";
import type { CatalogSkill } from "#execution/catalog/skills.js";
import {
  dynamicSkillAnnouncements,
  formatAvailableSkillsSection,
} from "#execution/skills/instructions.js";

function createTestSkill(
  overrides: Partial<CompiledSkillDefinition> = {},
): CompiledSkillDefinition {
  const name = overrides.name ?? "test-skill";

  return {
    description: "A test skill",
    logicalPath: `skills/${name}/SKILL.md`,
    content: "# Test\nDo the thing.",
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
      "If multiple skills match, activate the minimal set that covers the task.",
    );
    expect(result).toContain("Skill files live under `$HOME/.agents/skills/<skill>/`");
    expect(result).toContain(
      "`skills/<skill>/` under the workspace root as the fallback when `$HOME` is unavailable",
    );
    expect(result).toContain(
      "resolve them relative to the directory containing that specific SKILL.md",
    );
    expect(result).toContain(
      "- test-skill: A test skill (path: $HOME/.agents/skills/test-skill/SKILL.md)",
    );
  });

  it("omits the path for skills without sandbox files", () => {
    const result = formatAvailableSkillsSection([
      { description: "Inline only", hasFiles: false, name: "inline" },
    ]);

    expect(result?.split("\n").at(-1)).toBe("- inline: Inline only");
  });

  it("omits the skill file rules when no listed skill has files", () => {
    const result = formatAvailableSkillsSection([
      { description: "Inline only", hasFiles: false, name: "inline" },
    ]);

    expect(result).not.toContain("Skill files live under");
    expect(result).not.toContain("sibling files");
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
    const skill = createTestSkill({ content: "# Full Instructions\nStep 1: Do this." });

    const result = formatAvailableSkillsSection([skill]);

    expect(result).toContain("Available skills");
    expect(result).toContain("- test-skill: A test skill");
    expect(result).not.toContain("Skill (test-skill)");
    expect(result).not.toContain("# Full Instructions");
  });
});

function dynamicSkill(name: string, overrides: Partial<CatalogSkill> = {}): CatalogSkill {
  return {
    deferred: false,
    description: `Rules for ${name}.`,
    markdown: "# Rules",
    name,
    source: `skills/${name}.ts`,
    ...overrides,
  };
}

function announced(
  current: readonly CatalogSkill[],
  listedInSystem: boolean,
  before?: readonly CatalogSkill[],
): string | undefined {
  const previous =
    before === undefined
      ? undefined
      : dynamicSkillAnnouncements(before, { listedInSystem }).skills!.value;
  return dynamicSkillAnnouncements(current, { listedInSystem }).skills!.render(previous);
}

describe("dynamicSkillAnnouncements", () => {
  it("sends only the skill list when the system prompt already has the skill rules", () => {
    expect(announced([dynamicSkill("plan-playbook")], true)).toBe(
      [
        "<skills_update>",
        "This dynamic skill announcement is from eve, not the user.",
        "Available skills",
        "- plan-playbook: Rules for plan-playbook.",
        "</skills_update>",
      ].join("\n"),
    );
  });

  it("keeps the skill rules when the system prompt has no skills section", () => {
    const text = announced([dynamicSkill("plan-playbook")], false);

    expect(text).toMatch(/^<skills_update>\n/u);
    expect(text).toContain("Listed skills are available in this run.");
    expect(text).toContain("- plan-playbook: Rules for plan-playbook.");
    expect(text).not.toContain("Skill files live under");
  });

  it("includes the skill file rules only when an announced skill has files", () => {
    const text = announced(
      [dynamicSkill("plan-playbook", { path: "$HOME/.agents/skills/plan-playbook/SKILL.md" })],
      false,
    );

    expect(text).toContain("Skill files live under");
    expect(text).toContain(
      "- plan-playbook: Rules for plan-playbook. (path: $HOME/.agents/skills/plan-playbook/SKILL.md)",
    );
  });

  it("names the skills an announcement withdraws", () => {
    expect(
      announced([dynamicSkill("team")], true, [dynamicSkill("team"), dynamicSkill("trial")]),
    ).toBe(
      [
        "<skills_update>",
        "This dynamic skill announcement is from eve, not the user.",
        "Available skills",
        "- team: Rules for team.",
        "No longer available: trial",
        "</skills_update>",
      ].join("\n"),
    );
    expect(announced([], true, [dynamicSkill("team")])).toBe(
      [
        "<skills_update>",
        "This dynamic skill announcement is from eve, not the user.",
        "No dynamic skills are available now.",
        "No longer available: team",
        "</skills_update>",
      ].join("\n"),
    );
  });

  it("announces nothing until a dynamic skill appears", () => {
    const { initial, value } = dynamicSkillAnnouncements([], { listedInSystem: true }).skills!;

    expect(value).toBe(initial);
  });
});
