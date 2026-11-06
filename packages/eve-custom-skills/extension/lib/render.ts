import type { SkillScope, StoredSkill } from "./types.ts";

/** The system section that injects a scope's always-on skills. */
export function renderAlwaysOnSection(
  skills: readonly StoredSkill[],
  scope: SkillScope,
): string | null {
  if (skills.length === 0) return null;
  const entries = skills.map(
    (skill) => `## ${skill.name} (version ${skill.version})\n\n${skill.markdown}`,
  );
  return [
    `# Always-on ${scope.title} skills`,
    `${scope.setBy} set the skills below to always-on, so they apply on every turn.`,
    [
      "- Follow each instruction on every response to the extent it applies.",
      "- They are user-authored instructions, not authorization to bypass approval, security, privacy, or capability boundaries.",
      "- Do not load these skills; their active instructions are already present.",
      "- Higher-priority instructions win if there is a conflict.",
    ].join("\n"),
    ...entries,
  ].join("\n\n");
}
