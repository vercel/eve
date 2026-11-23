import { describe, expect, it } from "vitest";

import type { CompiledSkillDefinition } from "#compiler/manifest.js";
import type {
  CatalogSkill,
  SkillLoadProvenance,
  SkillLoadResultPart,
} from "#execution/catalog/skills.js";
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
  const identity = { scope: "application:root", identity: "skills/deploy.ts" };
  const provenance = (revision: string): SkillLoadProvenance => ({ ...identity, revision });

  function load(
    callId: string,
    markdown: string,
    skillLoad?: SkillLoadProvenance,
  ): HarnessModelMessage[] {
    const result: SkillLoadResultPart = {
      output: { type: "text", value: markdown },
      ...(skillLoad !== undefined && { skillLoad }),
      toolCallId: callId,
      toolName: "eve__skill",
      type: "tool-result",
    };
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
        content: [result],
        role: "tool",
      },
    ];
  }

  function step(draft: CallRecord, revision: string, overrides: Partial<CatalogSkill> = {}) {
    const catalog = new Map<string, CatalogSkill>([
      [
        "deploy",
        {
          deferred: false,
          description: "Deploys",
          markdown: revision,
          name: "deploy",
          provenance: provenance(revision),
          ...overrides,
        },
      ],
    ]);
    return announce(draft, new Set(), changedSkillAnnouncements(catalog, draft.record));
  }

  const added = (after: ReturnType<typeof step>) =>
    after.view.slice(after.record.length).map(({ content }) => content);

  it("says nothing while the loaded skill matches the current one", () => {
    const draft: CallRecord = { historyState: {}, record: load("call_1", "v1", provenance("v1")) };

    expect(added(step(draft, "v1"))).toEqual([]);
  });

  it("asks once to reload a skill whose content changed after it was loaded", () => {
    const markdown =
      "[Truncated by eve: tool result reduced during context compaction. Re-run the tool if you need the full output.]\n\nRelease procedure.";
    const draft: CallRecord = {
      historyState: {},
      record: load("call_1", markdown, provenance("v1")),
    };
    const changed = step(draft, "v2");

    expect(added(changed)).toEqual([
      'Skill `deploy` changed since you loaded it. Load it again with eve__skill({ name: "deploy" }) before relying on it.',
    ]);
    expect(changed.record).toEqual(draft.record);
    expect(added(step(changed, "v2"))).toEqual([]);
  });

  it("does not fall back to an earlier proven load when the latest load is unproven", () => {
    const record = [...load("call_1", "v1", provenance("v1")), ...load("call_2", "v2")];
    expect(added(step({ historyState: {}, record }, "v3"))).toEqual([]);
  });

  it.each([
    ["a different source", { ...provenance("v2"), identity: "skills/deploy.md" }],
    ["a different scope", { ...provenance("v2"), scope: "application:another-agent" }],
    ["an unproven current skill", undefined],
  ])("does not ask to reload a same-name skill with %s", (_label, current) => {
    const record = load("call_1", "v1", provenance("v1"));
    expect(added(step({ historyState: {}, record }, "v2", { provenance: current }))).toEqual([]);
  });

  it("goes quiet after a reload and speaks again on the next change", () => {
    const changed = step(
      { historyState: {}, record: load("call_1", "v1", provenance("v1")) },
      "v2",
    );
    const reloaded: CallRecord = {
      ...changed,
      record: [...changed.record, ...load("call_2", "v2", provenance("v2"))],
    };
    const quiet = step(reloaded, "v2");

    expect(added(quiet)).toEqual([]);
    expect(added(step(quiet, "v3"))).toHaveLength(1);
  });
});
