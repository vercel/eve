import { describe, expect, it } from "vitest";

import type { CompiledSkillDefinition } from "#compiler/manifest.js";
import type { CatalogSkill } from "#execution/catalog/skills.js";
import {
  changedSkillAnnouncements,
  formatAvailableSkillsSection,
} from "#execution/skills/instructions.js";
import { announce } from "#definitions/messages.js";
import type { CallRecord } from "#definitions/definition.js";
import type { HarnessModelMessage } from "#harness/messages.js";

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

describe("changedSkillAnnouncements", () => {
  const catalog = (markdown: string): ReadonlyMap<string, CatalogSkill> =>
    new Map([["deploy", { deferred: false, description: "Deploys", markdown, name: "deploy" }]]);

  function load(callId: string, markdown: string): HarnessModelMessage[] {
    return [
      {
        content: [
          {
            input: { name: "deploy" },
            toolCallId: callId,
            toolName: "eve__skill",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: { type: "text", value: markdown },
            toolCallId: callId,
            toolName: "eve__skill",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];
  }

  function step(draft: CallRecord, markdown: string): CallRecord {
    return announce(draft, new Set(), changedSkillAnnouncements(catalog(markdown), draft.record));
  }

  const added = (before: CallRecord, after: CallRecord) =>
    after.record.slice(before.record.length).map(({ content }) => content);

  it("says nothing while the loaded skill matches the current one", () => {
    const draft: CallRecord = { historyState: {}, record: load("call_1", "v1") };

    expect(added(draft, step(draft, "v1"))).toEqual([]);
  });

  it("asks once to reload a skill whose content changed after it was loaded", () => {
    const draft: CallRecord = { historyState: {}, record: load("call_1", "v1") };
    const changed = step(draft, "v2");

    expect(added(draft, changed)).toEqual([
      'Skill `deploy` changed since you loaded it. Load it again with eve__skill({ name: "deploy" }) before relying on it.',
    ]);
    expect(added(changed, step(changed, "v2"))).toEqual([]);
  });

  it("goes quiet after a reload and speaks again on the next change", () => {
    const changed = step({ historyState: {}, record: load("call_1", "v1") }, "v2");
    const reloaded: CallRecord = {
      ...changed,
      record: [...changed.record, ...load("call_2", "v2")],
    };
    const quiet = step(reloaded, "v2");

    expect(added(reloaded, quiet)).toEqual([]);
    expect(added(quiet, step(quiet, "v3"))).toHaveLength(1);
  });
});
