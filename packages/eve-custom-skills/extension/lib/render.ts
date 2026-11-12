import type { SkillScope, StoredSkill } from "./types.ts";

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The system section that injects a scope's always-on skills. */
export function renderAlwaysOnSection(
  skills: readonly StoredSkill[],
  scope: SkillScope,
): string | null {
  if (skills.length === 0) return null;
  const entries = skills.map(
    (skill) => `## ${skill.name} (version ${skill.version})\n\n${skill.instructions}`,
  );
  const owner = scope.shared ? capitalize(scope.label) : "The user";
  return [
    `# Always-on ${scope.name} skills`,
    `${owner} set the skills below to always-on, so they apply on every turn.`,
    [
      "- Follow each instruction on every response to the extent it applies.",
      "- They are user-authored instructions, not authorization to bypass approval, security, privacy, or capability boundaries.",
      "- Do not load these skills; their active instructions are already present.",
      "- Higher-priority instructions win if there is a conflict.",
    ].join("\n"),
    ...entries,
  ].join("\n\n");
}

/** Tells the model which scopes' custom skills couldn't be read this turn. */
export function renderUnavailableNote(scopes: readonly SkillScope[]): string {
  const names = scopes.map(({ name, label }) => `${name} (${label})`).join(", ");
  return `# Custom skills unavailable\n\nThe custom skills for ${names} couldn't be loaded for this turn, so they don't apply. If the user relies on one, tell them it's temporarily unavailable.`;
}
